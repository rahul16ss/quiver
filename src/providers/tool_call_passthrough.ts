/**
 * Provider-opaque tool-call field pass-through.
 *
 * Quiver speaks OpenAI-compat. Some hosts attach extra fields on tool_calls
 * that must be echoed verbatim on later turns (otherwise the next request
 * 400s). Those fields are transport concerns — never product/model logic.
 *
 * Rule: pass through unknown tool-call fields; do not invent provider-
 * specific product paths in the agent/skills/checker layers.
 */

/** OpenAI-compat keys Quiver already understands and manages itself. */
const MANAGED_TOOL_CALL_KEYS = new Set([
  "id",
  "type",
  "function",
  "index",
]);

export type ToolCallPassthrough = Record<string, unknown>;

/**
 * Capture every top-level tool_call field that isn't part of the managed
 * OpenAI-compat shape (e.g. `extra_content`, future vendor bags).
 */
export function extractToolCallPassthrough(
  raw: Record<string, unknown> | null | undefined,
): ToolCallPassthrough | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: ToolCallPassthrough = {};
  for (const [key, value] of Object.entries(raw)) {
    if (MANAGED_TOOL_CALL_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Merge streamed passthrough bags (later chunks win per key). */
export function mergeToolCallPassthrough(
  existing: ToolCallPassthrough | undefined,
  incoming: ToolCallPassthrough | undefined,
): ToolCallPassthrough | undefined {
  if (!existing && !incoming) return undefined;
  if (!existing) return incoming ? { ...incoming } : undefined;
  if (!incoming) return { ...existing };
  return { ...existing, ...incoming };
}

/** True when a stored tool call carries any opaque echo fields. */
export function toolCallHasPassthrough(
  tc: { passthrough?: ToolCallPassthrough; extra_content?: unknown } | null | undefined,
): boolean {
  if (!tc) return false;
  if (tc.passthrough && Object.keys(tc.passthrough).length > 0) return true;
  // Legacy field name from earlier Gemini-shaped storage — still echoed.
  if (tc.extra_content && typeof tc.extra_content === "object") return true;
  return false;
}

/**
 * Build the outbound tool_call object: managed fields + opaque passthrough.
 * Prefer `passthrough`; fall back to legacy `extra_content` for old sessions.
 */
export function shapeOutboundToolCall(tc: {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
  passthrough?: ToolCallPassthrough;
  extra_content?: unknown;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: tc.id,
    type: tc.type || "function",
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  };
  const bag =
    tc.passthrough ||
    (tc.extra_content && typeof tc.extra_content === "object"
      ? { extra_content: tc.extra_content }
      : undefined);
  if (bag) {
    for (const [key, value] of Object.entries(bag)) {
      if (MANAGED_TOOL_CALL_KEYS.has(key)) continue;
      base[key] = value;
    }
  }
  return base;
}
