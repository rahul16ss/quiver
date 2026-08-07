/**
 * Shared ProductionRuntime binding for the experience plane.
 *
 * Launcher constructs one ProductionRuntime and binds it here before serving
 * the browser UI. Chat (Agent) and workflows (ExecutionEngine) then share the
 * same broker, ExecutionContext, research-state store, and policy surface —
 * ending the dual-runtime split where chat reinvented its own guards.
 */

import type { ProductionRuntime } from "./production-runtime.js";

let bound: ProductionRuntime | null = null;

/** Bind the production runtime for this process. Idempotent replace. */
export function bindProductionRuntime(runtime: ProductionRuntime): void {
  bound = runtime;
}

/** Clear the binding (tests). */
export function clearProductionRuntime(): void {
  bound = null;
}

/** The currently bound runtime, or null if the process has not started production. */
export function getBoundProductionRuntime(): ProductionRuntime | null {
  return bound;
}

/** Network / research tools that MUST go through the IntegrationBroker. */
export const BROKERED_TOOL_NAMES = new Set([
  "web_search",
  "scrape_url",
  "deep_research",
  "find_all",
  "entity_search",
]);

/**
 * Invoke a tool under the bound runtime's policy. Brokered (network) tools
 * go through QuiverIntegrationBroker with ExecutionContext; everything else
 * executes via the provided local executor. Fail closed when a brokered tool
 * is requested but no runtime/broker is bound, or policy denies.
 */
export async function invokeUnderRuntime(
  toolName: string,
  args: Record<string, unknown>,
  localExecute: () => Promise<unknown>,
): Promise<{ ok: boolean; output?: unknown; error?: string; via: "broker" | "local" }> {
  const rt = bound;
  if (BROKERED_TOOL_NAMES.has(toolName)) {
    if (!rt) {
      return {
        ok: false,
        error: `Tool '${toolName}' requires the production IntegrationBroker; no ProductionRuntime is bound.`,
        via: "broker",
      };
    }
    // Profile already removed these tools in air-gap — double-check.
    if (rt.executionContext.toolPermissions.removed.has(toolName)) {
      return {
        ok: false,
        error: `Tool '${toolName}' is removed under deployment profile '${rt.deploymentProfile}'.`,
        via: "broker",
      };
    }
    // Prefer the registered parallel-research integration when present.
    const integration = rt.broker.get("parallel-research");
    if (!integration) {
      return {
        ok: false,
        error: `No parallel-research integration registered (unavailable: ${rt.unavailable.join("; ") || "none"}).`,
        via: "broker",
      };
    }
    const op = toolNameToParallelOp(toolName);
    const result = await rt.broker.invoke(
      "parallel-research",
      { op, args: mapToolArgs(toolName, args) },
      {
        executionContext: rt.executionContext,
        sensitivity: "public",
      },
    );
    if (!result.ok) {
      return { ok: false, error: result.error ?? "broker denied", via: "broker" };
    }
    // Harvest a research claim into the temporal store (hypothesis → recorded).
    try {
      recordResearchObservation(rt, toolName, args, result.data);
    } catch {
      /* never block the tool on memory harvest failure */
    }
    return { ok: true, output: result.data, via: "broker" };
  }

  // Local tools: still respect removed-tool set when a runtime is bound.
  if (rt?.executionContext.toolPermissions.removed.has(toolName)) {
    return {
      ok: false,
      error: `Tool '${toolName}' is removed under deployment profile '${rt.deploymentProfile}'.`,
      via: "local",
    };
  }
  try {
    const output = await localExecute();
    return { ok: true, output, via: "local" };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err), via: "local" };
  }
}

function toolNameToParallelOp(toolName: string): string {
  switch (toolName) {
    case "web_search":
    case "entity_search":
      return "search";
    case "scrape_url":
      return "extract";
    case "deep_research":
      return "research";
    case "find_all":
      return "research";
    default:
      return "search";
  }
}

function mapToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case "web_search":
    case "entity_search":
      return { query: args.query ?? args.q ?? "", opts: { sensitivity: "public" } };
    case "scrape_url":
      return { urls: Array.isArray(args.urls) ? args.urls : [args.url].filter(Boolean), opts: { sensitivity: "public" } };
    case "deep_research":
    case "find_all":
      return { input: args.query ?? args.objective ?? args.input ?? "", opts: { sensitivity: "public" } };
    default:
      return args;
  }
}

function recordResearchObservation(
  rt: ProductionRuntime,
  toolName: string,
  args: Record<string, unknown>,
  data: unknown,
): void {
  const query = String(args.query ?? args.objective ?? args.input ?? toolName);
  const now = new Date().toISOString();
  // Lightweight claim: observation of a research retrieval — not auto-promoted fact.
  rt.researchState.recordClaim({
    claimId: `research-${toolName}-${hashish(query)}`,
    validTime: now.slice(0, 10),
    recordedTime: now,
    kind: "assumption",
    claim: `Research observation via ${toolName}: ${query.slice(0, 200)}`,
    status: "unresolved",
    source: {
      category: "public-web-research",
      source: "parallel-research",
      locator: `broker:${toolName}`,
      retrievedAt: now,
    },
    sensitivity: "public",
    evidence: [`broker:${toolName}`, summarize(data).slice(0, 120)],
  });
}

function hashish(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function summarize(data: unknown): string {
  try {
    const s = JSON.stringify(data);
    return s.length > 400 ? s.slice(0, 397) + "..." : s;
  } catch {
    return String(data).slice(0, 400);
  }
}
