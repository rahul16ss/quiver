/**
 * Lifecycle Hooks — The Interception Engine
 *
 * Provides named lifecycle hooks that fire at deterministic stages of the
 * agent request pipeline. Hooks are interceptors: they can observe, log,
 * modify, or short-circuit each stage.
 *
 * Pipeline stages (in order):
 *
 *   Request
 *     → BEFORE_AGENT   (global persona & thread configs load)
 *     → BEFORE_MODEL   (inspect resolved prompt context payload)
 *       → wrap_model_call  (executes LLM inference stream step)
 *       → wrap_tool_call   (invokes execution scripts & dynamic tools)
 *     → AFTER_MODEL    (parses raw output signals & tool results)
 *     → AFTER_AGENT    (dumps session logs to files & exits)
 *   Result
 *
 * Each stage supports multiple registered hooks. Hooks are async functions
 * that receive a context object and can:
 *   - Read/modify the context (e.g. add to system prompt, filter tools)
 *   - Log/audit the stage for explainability
 *   - Return a short-circuit result to skip downstream stages
 *
 * This is a "low-level primitive" (Principle 05) — it's a building block,
 * not a black box. All hook registrations and firings are transparent and
 * logged.
 */

import picocolors from "picocolors";
import { config } from "./config.js";
import { theme } from "./cli_ui.js";
import { isHighRisk, runChecker } from "./subagents/checker.js";

// ─── Hook Types ───────────────────────────────────────────────────────

export type LifecycleStage =
  | "BEFORE_AGENT"
  | "BEFORE_MODEL"
  | "wrap_model_call"
  | "wrap_tool_call"
  | "AFTER_MODEL"
  | "AFTER_AGENT";

/** Context passed to every hook. Hooks can read and modify these fields. */
export interface LifecycleContext {
  /** The user's input prompt for this turn. */
  userInput: string;
  /** The full message array being sent to the model. */
  messages: any[];
  /** The system prompt string (modifiable by BEFORE_MODEL hooks). */
  systemPrompt: string;
  /** The active tools available (modifiable by BEFORE_MODEL hooks). */
  tools: any[];
  /** The model name being used. */
  model: string;
  /** Whether this is a vision-routed call. */
  isVision: boolean;
  /** The raw model response (populated after wrap_model_call). */
  modelResponse?: any;
  /** The tool call being executed (populated for wrap_tool_call). */
  toolCall?: { name: string; args: any };
  /** The tool result (populated after wrap_tool_call). */
  toolResult?: any;
  /** Session metadata. */
  sessionId: string;
  /** Loop iteration count (1-based). */
  loopCount: number;
  /** Arbitrary extension data hooks can attach. */
  metadata: Record<string, any>;
}

/** Result of a hook execution. */
export interface HookResult {
  /** If set, short-circuits the pipeline — this result replaces downstream output. */
  shortCircuit?: boolean;
  /** If short-circuiting, the replacement value. */
  value?: any;
  /** If false, aborts the entire pipeline (e.g. safety guard). */
  abort?: boolean;
  /** Abort reason for logging. */
  abortReason?: string;
}

export type HookFn = (
  ctx: LifecycleContext,
) => Promise<HookResult | void> | HookResult | void;

interface HookEntry {
  id: string;
  stage: LifecycleStage;
  fn: HookFn;
  description: string;
}

// ─── Hook Registry ────────────────────────────────────────────────────

/**
 * The global lifecycle hook registry.
 * Hooks are registered by stage and fired in registration order.
 */
export class LifecycleHookRegistry {
  private hooks: Map<LifecycleStage, HookEntry[]> = new Map();
  private firedLog: { stage: string; hookId: string; timestamp: string }[] = [];

  /**
   * Register a hook for a specific lifecycle stage.
   * @param stage - The pipeline stage to intercept.
   * @param id - Unique identifier for this hook (for removal/debugging).
   * @param fn - The hook function to execute.
   * @param description - Human-readable description for transparency.
   */
  register(
    stage: LifecycleStage,
    id: string,
    fn: HookFn,
    description: string = "",
  ): void {
    const entry: HookEntry = { id, stage, fn, description };
    if (!this.hooks.has(stage)) {
      this.hooks.set(stage, []);
    }
    this.hooks.get(stage)!.push(entry);
  }

  /** Remove a previously registered hook by ID. */
  unregister(id: string): void {
    for (const [stage, entries] of this.hooks) {
      const filtered = entries.filter((e) => e.id !== id);
      this.hooks.set(stage, filtered);
    }
  }

  /** Get all registered hooks for a stage (for transparency/debugging). */
  getHooks(stage: LifecycleStage): HookEntry[] {
    return this.hooks.get(stage) || [];
  }

  /** Get all registered hooks across all stages. */
  getAllHooks(): HookEntry[] {
    const all: HookEntry[] = [];
    for (const entries of this.hooks.values()) {
      all.push(...entries);
    }
    return all;
  }

  /** Get the log of fired hooks (for explainability/audit). */
  getFiredLog(): { stage: string; hookId: string; timestamp: string }[] {
    return [...this.firedLog];
  }

  /**
   * Fire all hooks for a given stage in registration order.
   * Hooks can modify the context. If any hook returns shortCircuit,
   * subsequent hooks for that stage are skipped and the value is returned.
   * If any hook returns abort, the pipeline is aborted.
   *
   * @returns The (possibly modified) context, plus any short-circuit/abort signal.
   */
  async fire(
    stage: LifecycleStage,
    ctx: LifecycleContext,
  ): Promise<{
    ctx: LifecycleContext;
    shortCircuit: boolean;
    value?: any;
    abort: boolean;
    abortReason?: string;
  }> {
    const entries = this.hooks.get(stage) || [];

    for (const entry of entries) {
      try {
        // Log the hook firing for audit trail
        this.firedLog.push({
          stage,
          hookId: entry.id,
          timestamp: new Date().toISOString(),
        });

        // Emit console trace only when explicitly enabled (default off). The
        // per-hook trace is noisy on every model/tool call, so it is opt-in via
        // QUIVER_LIFECYCLE_TRACE; audit data is always captured via logger events.
        if (process.env.QUIVER_LIFECYCLE_TRACE === "1") {
          process.stderr.write(
            picocolors.gray(
              `  ⎚ ${stage} → ${entry.id}${entry.description ? ` (${entry.description})` : ""}\n`,
            ),
          );
        }

        const result = await entry.fn(ctx);

        if (result && result.abort) {
          return {
            ctx,
            shortCircuit: false,
            abort: true,
            abortReason: result.abortReason || "Hook aborted pipeline",
          };
        }

        if (result && result.shortCircuit) {
          return {
            ctx,
            shortCircuit: true,
            value: result.value,
            abort: false,
          };
        }
      } catch (error: any) {
        // Security-critical hooks (maker-checker gate) must fail closed:
        // a transient checker failure must NOT silently skip the gate and
        // commit the high-risk write unverified. Non-security hooks fail
        // open (log and continue).
        const isSecurityCritical = entry.id.includes("checker") || entry.id.includes("security");
        if (isSecurityCritical) {
          process.stderr.write(
            picocolors.red(
              `  ✗ Security hook '${entry.id}' at ${stage} threw: ${error.message} — ABORTING (fail-closed)\n`,
            ),
          );
          throw new Error(
            `Security-critical hook '${entry.id}' failed at ${stage}: ${error.message}`,
          );
        }
        // Non-security hooks: log and continue
        if (config.outputMode === "interactive") {
          process.stderr.write(
            picocolors.yellow(
              `  Hook '${entry.id}' at ${stage} threw: ${error.message}\n`,
            ),
          );
        }
      }
    }

    return { ctx, shortCircuit: false, abort: false };
  }

  /** Clear all registered hooks. */
  clear(): void {
    this.hooks.clear();
    this.firedLog = [];
  }
}

/** The global singleton registry. */
export const lifecycleRegistry = new LifecycleHookRegistry();

// ─── Built-in Hooks ───────────────────────────────────────────────────
//
// These are registered by default to provide the explainability and
// audit features described on the landing page. They are transparent —
// the user can see them via /tools or the context manifest.

/**
 * Register the built-in lifecycle hooks that provide:
 * 1. Session logging at every stage (explainability)
 * 2. Context manifest display before model call (transparency)
 * 3. Tool result logging after tool execution (provenance)
 *
 * Called once at agent startup.
 */
export function registerBuiltinHooks(
  registry: LifecycleHookRegistry,
  logger: { logEvent: (type: string, data: any) => void },
): void {
  // BEFORE_AGENT: Log that the agent pipeline is starting
  registry.register(
    "BEFORE_AGENT",
    "builtin.session-log",
    (ctx) => {
      logger.logEvent("lifecycle_before_agent", {
        sessionId: ctx.sessionId,
        userInputLength: ctx.userInput.length,
        messageCount: ctx.messages.length,
      });
    },
    "Session pipeline start logging",
  );

  // BEFORE_MODEL: Log the resolved context payload (transparency)
  registry.register(
    "BEFORE_MODEL",
    "builtin.context-payload-log",
    (ctx) => {
      logger.logEvent("lifecycle_before_model", {
        model: ctx.model,
        isVision: ctx.isVision,
        systemPromptLength: ctx.systemPrompt.length,
        messageCount: ctx.messages.length,
        toolCount: ctx.tools.length,
        loopCount: ctx.loopCount,
      });
    },
    "Log resolved context payload before model call",
  );

  // wrap_model_call: Audit hook (fires before the actual fetch)
  registry.register(
    "wrap_model_call",
    "builtin.model-audit",
    (ctx) => {
      logger.logEvent("lifecycle_wrap_model_call", {
        model: ctx.model,
        loopCount: ctx.loopCount,
        messageCount: ctx.messages.length,
      });
    },
    "Audit model inference step",
  );

  // wrap_tool_call: Log tool invocation (provenance)
  registry.register(
    "wrap_tool_call",
    "builtin.tool-audit",
    (ctx) => {
      if (ctx.toolCall) {
        logger.logEvent("lifecycle_wrap_tool_call", {
          tool: ctx.toolCall.name,
          args: ctx.toolCall.args,
          loopCount: ctx.loopCount,
        });
      }
    },
    "Audit tool execution step",
  );

  // wrap_tool_call: Maker-checker verification gate (US-15.1).
  // The maker (agent) cannot self-certify its own work, so high-risk tool
  // calls are delegated to the structurally isolated checker subagent before
  // the change is committed. The checker runs the acceptance contract against
  // a copy-on-write scratchpad and emits an approve | reject | revise verdict;
  // a reject aborts the pipeline so the workspace is never mutated without an
  // independent verification pass.
  registry.register(
    "wrap_tool_call",
    "builtin.maker-checker-gate",
    async (ctx) => {
      // US-15.1: high-risk ops are ALWAYS verified — the maker cannot
      // self-certify, so the checker runs the acceptance contract against a
      // copy-on-write scratchpad before a high-risk change is committed. This
      // is an ambient characteristic of the harness (on every run, no opt-out)
      // per the user's maker-checker-for-every-run vision and the acceptance
      // contract (US-15.1 forbids gating it behind an env flag).
      if (ctx.toolCall && isHighRisk(ctx.toolCall.name, ctx.toolCall.args)) {
        const changeHash = String(
          ctx.metadata?.changeHash ??
            `${ctx.sessionId}:${ctx.loopCount}:${ctx.toolCall.name}`,
        );
        const verdict = await runChecker(
          changeHash,
          process.cwd(),
          ctx.toolCall.name,
          ctx.toolCall.args,
        );
        logger.logEvent("maker_checker_verdict", {
          tool: ctx.toolCall.name,
          verdict: verdict.verdict,
          changeHash,
          passed: verdict.passed,
          failed: verdict.failed,
          evidence: verdict.evidence,
        });
        if (verdict.verdict === "reject" || verdict.verdict === "revise") {
          return {
            abort: true,
            abortReason: `maker-checker ${verdict.verdict}ed change ${changeHash}: ${verdict.evidence}`,
          };
        }
      }
    },
    "Maker-checker verification gate for high-risk tool calls",
  );

  // AFTER_MODEL: Log the parsed model response
  registry.register(
    "AFTER_MODEL",
    "builtin.response-log",
    (ctx) => {
      logger.logEvent("lifecycle_after_model", {
        hasResponse: !!ctx.modelResponse,
        loopCount: ctx.loopCount,
      });
    },
    "Log parsed model output signals",
  );

  // AFTER_AGENT: Log that the pipeline is completing
  registry.register(
    "AFTER_AGENT",
    "builtin.session-end-log",
    (ctx) => {
      logger.logEvent("lifecycle_after_agent", {
        sessionId: ctx.sessionId,
        totalLoops: ctx.loopCount,
      });
    },
    "Session pipeline end logging",
  );
}

// ─── Convenience: Wrap functions ──────────────────────────────────────
//
// These wrappers are used by the agent loop to intercept model and tool
// calls. They create a LifecycleContext, fire the appropriate hooks,
// and return the result (or a short-circuit value).

/**
 * Wrap a model call with lifecycle hooks.
 * Fires BEFORE_MODEL → wrap_model_call → AFTER_MODEL.
 *
 * @param ctx - The lifecycle context (partially populated).
 * @param modelFn - The actual model fetch function to execute.
 * @returns The model response, or a short-circuit value.
 */
export async function wrapModelCall(
  ctx: LifecycleContext,
  modelFn: () => Promise<any>,
): Promise<any> {
  // BEFORE_MODEL: fire hooks that inspect/modify the context payload
  const beforeResult = await lifecycleRegistry.fire("BEFORE_MODEL", ctx);
  if (beforeResult.abort) {
    throw new Error(
      `Pipeline aborted at BEFORE_MODEL: ${beforeResult.abortReason}`,
    );
  }
  if (beforeResult.shortCircuit) {
    return beforeResult.value;
  }

  // wrap_model_call: fire hooks that audit the inference step
  const wrapResult = await lifecycleRegistry.fire("wrap_model_call", ctx);
  if (wrapResult.abort) {
    throw new Error(
      `Pipeline aborted at wrap_model_call: ${wrapResult.abortReason}`,
    );
  }
  if (wrapResult.shortCircuit) {
    ctx.modelResponse = wrapResult.value;
  } else {
    // Execute the actual model call
    ctx.modelResponse = await modelFn();
  }

  // AFTER_MODEL: fire hooks that parse/audit the response
  await lifecycleRegistry.fire("AFTER_MODEL", ctx);

  return ctx.modelResponse;
}

/**
 * Wrap a tool call with lifecycle hooks.
 * Fires wrap_tool_call hooks before the tool executes.
 *
 * @param ctx - The lifecycle context (toolCall populated).
 * @param toolFn - The actual tool execution function.
 * @returns The tool result, or a short-circuit value.
 */
export async function wrapToolCall(
  ctx: LifecycleContext,
  toolFn: () => Promise<any>,
): Promise<any> {
  // Execute the tool first so its changes are written to the workspace
  // and can be validated by the checker (US-15.1, US-15.3).
  ctx.toolResult = await toolFn();

  // wrap_tool_call: fire hooks that audit or verify the modifications
  const wrapResult = await lifecycleRegistry.fire("wrap_tool_call", ctx);
  if (wrapResult.abort) {
    // If validation fails (rejected or revise), rollback the last file write (US-10.2)
    const { rollbackLast } = await import("./fs/atomic_write.js");
    let rollbackError: string | null = null;
    try {
      await rollbackLast();
    } catch (rbErr: any) {
      // Rollback failure must propagate — do not swallow it.
      // A rejected destructive edit left on disk is a safety violation.
      rollbackError = rbErr.message;
    }
    throw new Error(
      `Pipeline aborted at wrap_tool_call: ${wrapResult.abortReason}` +
      (rollbackError ? ` (rollback also failed: ${rollbackError})` : ""),
    );
  }

  return ctx.toolResult;
}
