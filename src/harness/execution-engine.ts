/**
 * ExecutionEngine — Phase 4 (ADR-002).
 *
 * A limited LangGraph.js substrate: durable state, SQLite-backed checkpoints,
 * resumability, timeouts and human interrupts. It does NOT adopt the full
 * LangChain agent/tool ecosystem. Quiver's existing tool registry, policy
 * checks, evidence layer, approvals and maker/checker logic are wrapped as
 * graph nodes — not rewritten.
 *
 * Goal-seeking loop:
 *   1. inspect goal, available inputs, allowed capabilities  (makePlan)
 *   2. build/update plan + explicit gap ledger                 (makePlan)
 *   3. execute the next bounded action (tool)                  (runStep)
 *   4. verify tool success + deterministic assertions          (runVerify)
 *   5. verify evidence, freshness, source coverage             (runChecker)
 *   6. run independent checker/critic                           (runChecker)
 *   7. update remaining gaps                                    (runEvaluate)
 *   8. iterate within budgets                                    (route)
 *   9. stop only when all acceptance checks pass, or return an
 *      honest blocked/partial result stating exactly what remains
 *
 * A failed tool call, unsupported event, stale source, missing entitlement or
 * invalid Office file can never be reported as successful completion.
 */

import { StateGraph, Annotation, END, START, interrupt } from "@langchain/langgraph";
import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type {
  ExecutionEngine,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  PendingApproval,
  ModelClient,
  ModelMessage,
  ModelResult,
  ModelProfileRef,
  TraceSink,
  TraceSpan,
} from "./interfaces.js";
import type { GoalContract } from "./goal-contract.js";
import { GapLedger, initialLedger, evaluateCompletion } from "./goal-contract.js";
import { AUTO_PROFILE } from "./model-router.js";

// ─── Tool executor abstraction ────────────────────────────────────────

/**
 * Wraps Quiver's existing tool registry as a single callable. The engine does
 * not reimplement tools; it calls them through this seam with policy checks
 * applied by the caller. A failed tool call returns { ok: false } and is NEVER
 * reported as success.
 */
export interface ToolExecutor {
  call(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Names of tools currently available to this run (capability gating). */
  available(): string[];
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** Evidence/lineage references produced by the tool. */
  evidenceRefs?: string[];
}

// ─── Graph state ──────────────────────────────────────────────────────

const QuiverState = Annotation.Root({
  contract: Annotation<GoalContract>,
  ledgerEntries: Annotation<import("./goal-contract.js").GapLedgerEntry[]>,
  ledgerNextId: Annotation<number>,
  plan: Annotation<string[]>,
  completedSteps: Annotation<string[]>,
  iterations: Annotation<number>,
  doneChecks: Annotation<Array<{ id: string; pass: boolean; detail: string }>>,
  artifacts: Annotation<string[]>,
  pendingApproval: Annotation<PendingApproval | null>,
  stopReason: Annotation<string | null>,
  trace: Annotation<TraceSink>,
});

type QuiverStateType = typeof QuiverState.State;

// ─── QuiverExecutionEngine ────────────────────────────────────────────

export class QuiverExecutionEngine implements ExecutionEngine {
  private compiled: Promise<any>;

  constructor(
    private checkpointer: BaseCheckpointSaver,
    private model: ModelClient,
    private tools: ToolExecutor,
    private opts: { maxIterations?: number; stepTimeoutMs?: number } = {},
  ) {
    this.compiled = this.build();
  }

  private async build(): Promise<any> {
    const graph = new StateGraph(QuiverState)
      .addNode("makePlan", this.planNode.bind(this))
      .addNode("runStep", this.executeNode.bind(this))
      .addNode("runVerify", this.verifyNode.bind(this))
      .addNode("runChecker", this.checkerNode.bind(this))
      .addNode("runEvaluate", this.evaluateNode.bind(this))
      .addNode("runApprove", this.approveNode.bind(this))
      .addEdge(START, "makePlan")
      .addEdge("makePlan", "runStep")
      .addEdge("runStep", "runVerify")
      .addEdge("runVerify", "runChecker")
      .addEdge("runChecker", "runEvaluate")
      .addConditionalEdges("runEvaluate", this.routeAfterEvaluate.bind(this))
      .addEdge("runApprove", END)
      .compile({ checkpointer: this.checkpointer });
    return graph;
  }

  // ── Nodes ───────────────────────────────────────────────────────────

  private async planNode(state: QuiverStateType): Promise<Partial<QuiverStateType>> {
    const span = state.trace.startSpan("node.plan", { runId: state.contract.runId });
    if (state.plan.length === 0) {
      const contract = state.contract;
      // Maker/checker separation: the MAKER model decomposes the goal into a
      // plan (routed by modality via AUTO_PROFILE — native-doc when a document
      // is involved, text tier otherwise). Any failure or refusal falls back to
      // the deterministic plan so the engine never blocks.
      const deterministic = [
        ...contract.definitionOfDone,
        ...contract.requiredDeliverables.map((d) => `produce ${d.type}`),
        ...contract.requiredSourceCategories.map((c) => `resolve source ${c}`),
      ];
      let plan = deterministic;
      try {
        const prompt =
          `You are the planning agent for a capital-markets workflow. Objective: ${contract.objective}\n` +
          `Required deliverables: ${contract.requiredDeliverables.map((d) => `${d.type} (${d.mimeType})`).join(", ") || "none"}\n` +
          `Required source categories: ${contract.requiredSourceCategories.join(", ") || "none"}\n` +
          `Definition of done: ${contract.definitionOfDone.join("; ") || "none"}\n` +
          `Produce a numbered plan, one step per line, covering: evidence gathering, ` +
          `analysis, deliverable production, and verification. Keep it to 5-12 concrete steps.`;
        const res = await this.model.invoke(
          [{ role: "user", content: prompt }],
          { modelProfile: AUTO_PROFILE, role: "maker", sensitivity: contract.dataSensitivity },
        );
        const lines = parsePlanSteps(res.content);
        if (lines.length > 0) plan = lines;
      } catch {
        plan = deterministic; // honest fallback — never break the loop on model failure
      }
      state.plan = plan;
      state.trace.endSpan(span, { iterations: state.iterations, planSize: state.plan.length, makerRouted: plan !== deterministic });
      return { plan: state.plan };
    }
    state.trace.endSpan(span, { iterations: state.iterations, planSize: state.plan.length });
    return { plan: state.plan };
  }

  private async executeNode(state: QuiverStateType): Promise<Partial<QuiverStateType>> {
    const span = state.trace.startSpan("node.execute", { runId: state.contract.runId, iteration: state.iterations });
    const remaining = [...state.plan];
    const next = remaining.shift();
    if (!next) {
      state.trace.endSpan(span, { result: "no_action" });
      return { iterations: state.iterations + 1 };
    }
    const toolName = pickToolFor(next, this.tools.available());
    const res = await this.tools.call(toolName, { step: next });
    const ledger = GapLedger.from(state.ledgerEntries, state.ledgerNextId);
    if (res.ok) {
      // Resolve the matching ledger gap by category.
      const cat = categoryForStep(next);
      const gap = ledger.all().find((e) => e.status !== "resolved" && (cat ? e.category === cat : (e.description.includes(next) || next.includes(e.description))));
      if (gap) ledger.resolve(gap.id);
    } else {
      // A failed tool call is never success — record a blocked gap.
      const g = ledger.add(`Tool '${toolName}' failed for: ${next}`, "deliverable", toolName);
      ledger.block(g.id, res.error ?? "tool failed");
    }
    const completedSteps = res.ok ? [...state.completedSteps, next] : state.completedSteps;
    const artifacts = res.ok && res.evidenceRefs ? [...state.artifacts, ...res.evidenceRefs] : state.artifacts;
    state.trace.endSpan(span, { tool: toolName, ok: res.ok });
    const snap = ledger.snapshot();
    return { plan: remaining, completedSteps, artifacts, iterations: state.iterations + 1, ledgerEntries: snap.entries, ledgerNextId: snap.nextId };
  }

  private async verifyNode(state: QuiverStateType): Promise<Partial<QuiverStateType>> {
    const span = state.trace.startSpan("node.verify", { runId: state.contract.runId });
    // Deterministic assertions: each definition-of-done item maps to a check
    // that passes only when a corresponding step was actually completed.
    const checks = state.contract.definitionOfDone.map((d) => {
      const satisfied = state.completedSteps.includes(d);
      return { id: `dod:${d}`, pass: satisfied, detail: satisfied ? "met" : "not yet met" };
    });
    state.trace.endSpan(span, { checks: checks.length, passed: checks.filter((c) => c.pass).length });
    return { doneChecks: checks };
  }

  private async checkerNode(state: QuiverStateType): Promise<Partial<QuiverStateType>> {
    const span = state.trace.startSpan("node.checker", { runId: state.contract.runId });
    const ledger = GapLedger.from(state.ledgerEntries, state.ledgerNextId);
    const summary = ledger.summary();
    // Independent checker/critic via the model client (checker role). Maker/
    // checker separation: it inspects the gap ledger + done checks and may flag
    // unresolved items. It never marks a failed step success.
    const prompt = `You are an independent checker. Open gap items: ${summary.unresolved.length}. Done checks passed: ${state.doneChecks.filter((c) => c.pass).length}/${state.doneChecks.length}. If all mandatory items are met, reply OK; otherwise list unresolved items.`;
    let checkerOk = true;
    try {
      const res = await this.model.invoke(
        [{ role: "user", content: prompt }],
        { modelProfile: AUTO_PROFILE, role: "checker", sensitivity: state.contract.dataSensitivity },
      );
      checkerOk = /^OK/i.test(res.content.trim()) && this.preCheckerReady(state);
    } catch {
      checkerOk = false;
    }
    const checkerGap = ledger.all().find((e) => e.category === "validation" && e.status !== "resolved");
    if (checkerOk) {
      if (checkerGap) ledger.resolve(checkerGap.id);
    } else if (!ledger.all().some((e) => e.category === "validation" && e.status !== "resolved")) {
      const g = ledger.add("Independent checker flagged unresolved mandatory items", "validation");
      ledger.block(g.id, "checker rejected");
    }
    const snap = ledger.snapshot();
    state.trace.endSpan(span, { checkerOk });
    return { ledgerEntries: snap.entries, ledgerNextId: snap.nextId };
  }

  private async evaluateNode(state: QuiverStateType): Promise<Partial<QuiverStateType>> {
    const ledger = GapLedger.from(state.ledgerEntries, state.ledgerNextId);
    const evalResult = evaluateCompletion(state.contract, ledger, state.doneChecks);
    return { stopReason: evalResult.stopReason };
  }

  private routeAfterEvaluate(state: QuiverStateType): string {
    const maxIter = this.opts.maxIterations ?? 5;
    if (state.iterations >= maxIter) return "runApprove";
    if (this.readyForApproval(state)) return "runApprove";
    // Blocked or partial → loop back to plan within budget.
    return "makePlan";
  }

  private async approveNode(state: QuiverStateType): Promise<Partial<QuiverStateType>> {
    const ledger = GapLedger.from(state.ledgerEntries, state.ledgerNextId);
    const evalResult = evaluateCompletion(state.contract, ledger, state.doneChecks);
    // Evaluate readiness once into a local; the interrupt below must fire only
    // when the run is genuinely complete, never for a failed/partial run.
    const ready = this.readyForApproval(state);
    if (!ready) {
      // Honest blocked/partial result — do NOT request approval for a failed run.
      return { stopReason: evalResult.stopReason };
    }
    // Human interrupt: approval gate before commit. The graph pauses; the
    // caller resumes with a Command({ resume: decision }).
    const decision = interrupt({ kind: "commit_approval", summary: "All acceptance checks passed. Approve commit?" });
    if (decision?.approved) {
      const approvalGap = ledger.all().find((e) => e.category === "approval" && e.status !== "resolved");
      if (approvalGap) ledger.resolve(approvalGap.id);
      const snap = ledger.snapshot();
      return { stopReason: "approved by human reviewer", ledgerEntries: snap.entries, ledgerNextId: snap.nextId };
    }
    const g = ledger.add("Human reviewer rejected the change set", "approval");
    ledger.block(g.id, "rejected");
    const snap = ledger.snapshot();
    return { stopReason: "rejected by human reviewer", ledgerEntries: snap.entries, ledgerNextId: snap.nextId };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /** Everything except the checker-validation and approval gates is done. */
  private preCheckerReady(state: QuiverStateType): boolean {
    const ledger = GapLedger.from(state.ledgerEntries, state.ledgerNextId);
    const open = ledger.open().filter((e) => e.category !== "approval" && e.category !== "validation");
    return open.length === 0 && state.doneChecks.every((c) => c.pass);
  }

  /** Ready for the human approval gate: all non-approval gaps resolved + checks pass. */
  private readyForApproval(state: QuiverStateType): boolean {
    const ledger = GapLedger.from(state.ledgerEntries, state.ledgerNextId);
    const open = ledger.open().filter((e) => e.category !== "approval");
    return open.length === 0 && state.doneChecks.every((c) => c.pass);
  }

  // ── Public API ──────────────────────────────────────────────────────

  async run(contract: GoalContract, options: RunOptions = {}): Promise<RunOutcome> {
    const graph = await this.compiled;
    const trace = (options as any).trace as TraceSink | undefined;
    const ledger = initialLedger(contract);
    const maxIter = this.opts.maxIterations ?? 5;
    const initialState = {
      contract,
      ledgerEntries: ledger.snapshot().entries,
      ledgerNextId: ledger.snapshot().nextId,
      plan: [] as string[],
      completedSteps: [] as string[],
      iterations: 0,
      doneChecks: [] as Array<{ id: string; pass: boolean; detail: string }>,
      artifacts: [] as string[],
      pendingApproval: null as PendingApproval | null,
      stopReason: null as string | null,
      trace: trace ?? new NoopTraceSink(),
    };
    const config = {
      configurable: { thread_id: contract.runId },
      recursionLimit: maxIter * 8 + 16,
      ...(options.budget?.timeoutMs ? { timeout: options.budget.timeoutMs } : {}),
    };
    try {
      const result = await graph.invoke(initialState, config);
      // LangGraph pauses on interrupt without throwing; detect via state.next.
      const state = await graph.getState(config);
      if (state?.next?.length) {
        return {
          runId: contract.runId,
          status: "paused",
          stopReason: "awaiting human approval",
          unresolved: [],
          artifacts: (result as QuiverStateType).artifacts ?? [],
          runRecord: { paused: true, iterations: (result as QuiverStateType).iterations },
        };
      }
      return this.toOutcome(result as QuiverStateType);
    } catch (err) {
      if (String((err as Error).message).includes("interrupt") || (err as any)?.name === "GraphInterrupt") {
        const snap = await this.inspect(contract.runId);
        return {
          runId: contract.runId,
          status: "paused",
          stopReason: "awaiting human approval",
          unresolved: snap?.pendingApprovals.map((p) => p.summary) ?? [],
          artifacts: [],
          runRecord: { paused: true },
        };
      }
      throw err;
    }
  }

  async resume(runId: string, humanInput: unknown, _options?: RunOptions): Promise<RunOutcome> {
    // §12 idempotency: if this thread has no pending interrupt (already
    // resolved — completed or rejected/blocked), a re-invoked resume must NOT
    // re-trigger the approval gate. Return the existing outcome unchanged so a
    // duplicate/retried resume can never double-commit or double-reject.
    const existing = await this.inspect(runId);
    if (existing && existing.status !== "paused") {
      const graph = await this.compiled;
      const config = { configurable: { thread_id: runId }, recursionLimit: (this.opts.maxIterations ?? 5) * 8 + 16 };
      const st = (await graph.getState(config)).values as QuiverStateType;
      return this.toOutcome(st);
    }
    const graph = await this.compiled;
    const maxIter = this.opts.maxIterations ?? 5;
    const config = { configurable: { thread_id: runId }, recursionLimit: maxIter * 8 + 16 };
    const result = await graph.invoke(new Command({ resume: humanInput }), config);
    return this.toOutcome(result as QuiverStateType);
  }

  async inspect(runId: string): Promise<RunSnapshot | null> {
    const graph = await this.compiled;
    const snap = await graph.getState({ configurable: { thread_id: runId } });
    if (!snap || !snap.values) return null;
    const v = snap.values as QuiverStateType;
    const vLedger = GapLedger.from(v.ledgerEntries, v.ledgerNextId);
    const evalResult = evaluateCompletion(v.contract, vLedger, v.doneChecks);
    const pending: PendingApproval[] = snap.next?.length
      ? [{ id: "approval", kind: "commit", summary: v.stopReason ?? "awaiting approval" }]
      : [];
    return {
      runId,
      status: snap.next?.length ? "paused" : evalResult.status === "completed" ? "completed" : "blocked",
      currentPhase: snap.next?.[0] ?? "done",
      gapLedger: vLedger.all().map((e) => ({ id: e.id, description: e.description, category: e.category, status: e.status, blocker: e.blocker })),
      pendingApprovals: pending,
      stopReason: v.stopReason ?? undefined,
      unresolved: evalResult.unresolved,
    };
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    await this.checkpointer.deleteThread(runId).catch(() => {});
    void reason;
  }

  private toOutcome(state: QuiverStateType): RunOutcome {
    const ledger = GapLedger.from(state.ledgerEntries, state.ledgerNextId);
    const evalResult = evaluateCompletion(state.contract, ledger, state.doneChecks);
    const status: RunOutcome["status"] =
      state.stopReason === "approved by human reviewer"
        ? "completed"
        : state.stopReason === "rejected by human reviewer"
          ? "partial"
          : evalResult.status === "blocked"
            ? "blocked"
            : evalResult.status === "completed"
              ? "completed"
              : "partial";
    return {
      runId: state.contract.runId,
      status,
      stopReason: state.stopReason ?? evalResult.stopReason,
      unresolved: evalResult.unresolved,
      artifacts: state.artifacts,
      runRecord: {
        iterations: state.iterations,
        doneChecks: state.doneChecks,
        ledger: ledger.all(),
        completedSteps: state.completedSteps,
      },
    };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function categoryForStep(step: string): string | null {
  if (step.startsWith("resolve source ")) return step.slice("resolve source ".length);
  if (step.startsWith("produce ")) return "deliverable";
  return null;
}

function pickToolFor(step: string, available: string[]): string {
  const lower = step.toLowerCase();
  if (/produce|deliverable/.test(lower) && available.includes("office_doc")) return "office_doc";
  if (/source|research|search/.test(lower) && available.includes("deep_research")) return "deep_research";
  if (/figure|evidence|sourced/.test(lower) && available.includes("evidence")) return "evidence";
  return available[0] ?? "noop";
}

/**
 * Parse the maker model's numbered plan text into concrete step strings.
 * Extracts lines that are non-empty, non-numeric-only, and not prose headers;
 * guarantees at least one step or returns [] (caller then falls back).
 */
function parsePlanSteps(content: string): string[] {
  if (!content) return [];
  const steps = content
    .split(/\n/)
    .map((l) => l.replace(/^\s*\d+[.)]?\s*/, "").trim())
    .filter((l) => l.length > 3 && !/^([A-Za-z\s:]+\d*[:.]?)$/.test(l) && !/^(objective|deliverables|sources|definition|plan|analysis|verification|step|the plan)/i.test(l));
  return steps;
}

function pickCheckerProfile(model: ModelClient): string {
  const profiles = model.listProfiles();
  const checker = profiles.find((p) => p.checkerEligible);
  return checker?.slug ?? profiles[0]?.slug ?? "local-private-default";
}

// Auto-routing sentinel — the ModalityRouter selects the actual profile per
// call from message modality + role + sensitivity (native-doc vs text tier).

/** A no-op trace sink for runs that don't supply one. */
class NoopTraceSink implements TraceSink {
  readonly redactsContent = true;
  startSpan(name: string, attrs: Record<string, unknown> = {}): TraceSpan {
    return { spanId: "noop", name, attrs };
  }
  event(): void {}
  endSpan(): void {}
}

// Re-export mock-friendly types for tests.
export type { ModelClient, ModelMessage, ModelResult, ModelProfileRef };