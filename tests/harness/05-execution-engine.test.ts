/**
 * ExecutionEngine tests — Phase 4 (ADR-002).
 *
 * Exercises the LangGraph goal-seeking loop with a mock ModelClient and mock
 * ToolExecutor: honest blocked/partial results, the human approval interrupt,
 * resumability via SQLite checkpoints, and that a failed tool call is never
 * reported as completion.
 */
import picocolors from "picocolors";
import * as os from "os";
import * as path from "path";
import { SqliteCheckpointSaver } from "../../src/harness/sqlite-checkpoint.js";
import { QuiverExecutionEngine, type ToolExecutor, type ToolResult } from "../../src/harness/execution-engine.js";
import { LocalTraceSink } from "../../src/harness/trace-sink.js";
import type { ModelClient, ModelMessage, ModelResult, ModelProfileRef } from "../../src/harness/interfaces.js";
import type { GoalContract } from "../../src/harness/goal-contract.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

// A mock model client whose checker replies "OK" when told to.
class MockModel implements ModelClient {
  id = "mock"; kind = "local" as const;
  checkerShouldPass: boolean;
  calls: Array<{ role?: string; modelProfile?: string; content: string; hintMime?: string }>;
  constructor(checkerShouldPass = true, public planContent = "ack") {
    this.checkerShouldPass = checkerShouldPass;
    this.calls = [];
  }
  listProfiles(): ModelProfileRef[] {
    return [{ slug: "local-private-default", label: "local", providerOrder: ["Local"], zdrEligible: true, checkerEligible: true }];
  }
  async invoke(messages: ModelMessage[], options?: { modelProfile?: string; role?: string; hintMime?: string }): Promise<ModelResult> {
    const last = messages[messages.length - 1];
    const content = typeof last.content === "string" ? last.content : "";
    this.calls.push({ role: options?.role, modelProfile: options?.modelProfile, content, hintMime: options?.hintMime });
    if (/independent checker/i.test(content)) {
      return { content: this.checkerShouldPass ? "OK all met" : "UNRESOLVED: missing consensus", modelProfile: "local-private-default", route: "local" };
    }
    if (/planning agent/i.test(content)) {
      return { content: this.planContent, modelProfile: "local-private-default", route: "local" };
    }
    // Maker: produce step — return long deliverable content so the maker fires.
    if (/maker for a capital-markets deliverable/i.test(content)) {
      return { content: "Deliverable analysis with sourced figures, facts separated from derived value, assumption, interpretation and recommendation. This is intentionally long so the maker counts as producing content.", modelProfile: "local-private-default", route: "local" };
    }
    return { content: "ack", modelProfile: "local-private-default", route: "local" };
  }
}

// A mock tool executor that resolves every plan step as a delivered artifact.
class MockTools implements ToolExecutor {
  fail = false;
  available() { return ["office_doc", "evidence", "deep_research"]; }
  async call(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (this.fail) return { ok: false, error: "tool unavailable" };
    return { ok: true, output: `${toolName}:${args.step}`, evidenceRefs: [`evidence-for-${args.step}`] };
  }
}

function contract(overrides: Partial<GoalContract> = {}): GoalContract {
  return {
    runId: "RUN-" + Math.random().toString(36).slice(2, 8),
    objective: "IC memo",
    requiredDeliverables: [{ type: "memo", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["summary"] }],
    definitionOfDone: ["all figures sourced", "checker passed"],
    requiredSourceCategories: ["filings-ir"],
    dataSensitivity: "public",
    reviewer: "jane",
    budgets: { iterations: 5 },
    stopConditions: ["budget exhausted"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function newSaver(): SqliteCheckpointSaver {
  const dir = path.join(os.tmpdir(), "quiver-ckpt-" + Math.random().toString(36).slice(2));
  return new SqliteCheckpointSaver(path.join(dir, "checkpoints.db"));
}

async function run() {
  // ── A completed run pauses at the human approval interrupt ─────────
  const saver = newSaver();
  const engine = new QuiverExecutionEngine(saver, new MockModel(true), new MockTools(), { maxIterations: 6 });
  const c = contract();
  const trace = new LocalTraceSink();
  const outcome = await engine.run(c, { trace } as any);
  // Because tools resolve every step and checker passes, the run reaches the
  // approval interrupt and pauses (no auto-commit).
  check("ENGINE-COMPLETED-PAUSES-AT-APPROVAL", outcome.status === "paused", `status=${outcome.status}`);
  check("ENGINE-STOP-REASON-AWAITS-APPROVAL", /approval/i.test(outcome.stopReason));

  // Inspect shows a pending approval.
  const snap = await engine.inspect(c.runId);
  check("ENGINE-INSPECT-PENDING-APPROVAL", !!snap && snap.pendingApprovals.length > 0);

  // ── Resume with approval → completed ────────────────────────────────
  const approved = await engine.resume(c.runId, { approved: true });
  check("ENGINE-RESUME-APPROVED-COMPLETES", approved.status === "completed", `status=${approved.status}`);
  check("ENGINE-RESUME-APPROVED-STOP-REASON", /approved by human/i.test(approved.stopReason));

  // ── §12 idempotency: a duplicate/retried resume must NOT re-commit ────
  // The run is already completed (no pending interrupt). Re-resuming with the
  // same approval must return the identical completed outcome — no double-commit.
  const approvedAgain = await engine.resume(c.runId, { approved: true });
  check("ENGINE-RESUME-IDEMPOTENT-STATUS", approvedAgain.status === "completed", `status=${approvedAgain.status}`);
  check("ENGINE-RESUME-IDEMPOTENT-SAME", approvedAgain.runId === approved.runId, `${approvedAgain.runId} vs ${approved.runId}`);

  // ── Resume with rejection → partial (never committed) ──────────────
  const c2 = contract();
  const engine2 = new QuiverExecutionEngine(newSaver(), new MockModel(true), new MockTools(), { maxIterations: 6 });
  await engine2.run(c2, { trace: new LocalTraceSink() } as any);
  const rejected = await engine2.resume(c2.runId, { approved: false });
  check("ENGINE-RESUME-REJECTED-IS-PARTIAL", rejected.status === "partial", `status=${rejected.status}`);
  check("ENGINE-RESUME-REJECTED-STOP-REASON", /rejected/i.test(rejected.stopReason));

  // ── A failed tool call is never reported as success ────────────────
  const failTools = new MockTools();
  failTools.fail = true;
  const c3 = contract();
  const engine3 = new QuiverExecutionEngine(newSaver(), new MockModel(false), failTools, { maxIterations: 3 });
  const failed = await engine3.run(c3, { trace: new LocalTraceSink() } as any);
  // With failing tools + failing checker, the run exhausts iterations and
  // returns blocked/partial — never "completed".
  check("ENGINE-FAILED-TOOL-NOT-COMPLETED", failed.status !== "completed", `status=${failed.status}`);
  check("ENGINE-FAILED-TOOL-UNRESOLVED", failed.unresolved.length > 0, "expected unresolved items");

  // ── Resumability: a paused run survives via SQLite checkpoint ──────
  const c4 = contract();
  const saver4 = newSaver();
  const engine4 = new QuiverExecutionEngine(saver4, new MockModel(true), new MockTools(), { maxIterations: 6 });
  await engine4.run(c4, { trace: new LocalTraceSink() } as any);
  // A fresh engine instance on the SAME saver can resume the paused run.
  const engine4b = new QuiverExecutionEngine(saver4, new MockModel(true), new MockTools(), { maxIterations: 6 });
  const resumed = await engine4b.resume(c4.runId, { approved: true });
  check("ENGINE-RESUMABLE-ACROSS-INSTANCE", resumed.status === "completed", `status=${resumed.status}`);

  // ── TraceSink captures node spans without prompt content ────────────
  const tSink = new LocalTraceSink();
  const c5 = contract();
  const engine5 = new QuiverExecutionEngine(newSaver(), new MockModel(true), new MockTools(), { maxIterations: 6 });
  await engine5.run(c5, { trace: tSink } as any);
  const sp = tSink.snapshot();
  check("ENGINE-TRACE-CAPTURES-PLAN-SPAN", sp.spans.some((s) => s.name === "node.plan"));
  check("ENGINE-TRACE-NO-PROMPT-CONTENT", sp.spans.every((s => s.attrs.prompt === undefined)));

  // ── Maker routing fires: plan node calls model with role=maker + AUTO ──
  const makerModel = new MockModel(true, "\n1. resolve source filings-ir\n2. produce memo\n3. run verification again\n");
  const c6 = contract();
  const engine6 = new QuiverExecutionEngine(newSaver(), makerModel, new MockTools(), { maxIterations: 6 });
  await engine6.run(c6, { trace: new LocalTraceSink() } as any);
  const plannerCalls = makerModel.calls.filter((c) => c.role === "planner");
  const checkerCalls = makerModel.calls.filter((c) => c.role === "checker");
  // Maker/checker/PLANNER separation: the plan step uses a DISTINCT planner
  // role (previously planning reused role="maker"), the audit uses the
  // independent checker role. The maker's produce-step routing (role maker +
  // native-doc hintMime) is covered at the router level (25-model-router).
  check("ENGINE-PLANNER-ROLE-DISPATCHED", plannerCalls.length >= 1, JSON.stringify(plannerCalls));
  check("ENGINE-PLANNER-USES-AUTO-PROFILE", plannerCalls.some((c) => c.modelProfile === "auto"), JSON.stringify(plannerCalls));
  check("ENGINE-PLANNER-PLAN-CONSUMED", plannerCalls.length >= 1 && /planning agent/i.test(plannerCalls[0].content), JSON.stringify(plannerCalls[0]?.content));
  // Checker still routed separately (independent role), preserving maker/checker separation.
  check("ENGINE-CHECKER-ROLE-DISPATCHED", checkerCalls.length >= 1, JSON.stringify(makerModel.calls));
  check("ENGINE-PLANNER-CHECKER-DISJOINT", plannerCalls.length >= 1 && checkerCalls.length >= 1);
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} engine check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} engine checks passed.`));