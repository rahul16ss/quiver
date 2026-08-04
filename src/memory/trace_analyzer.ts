/**
 * Automated Trace Analysis & Extraction — US-4.2
 *
 * Triggers a lightweight extraction LLM pass on session completion.
 * Extracts preferences, common errors, and project architecture facts.
 * New extracted memories enter a 'pending' state in the memory review queue.
 */

import { createMemoryFact, appendMemoryFact, type MemoryFact, type MemoryType } from "./schema.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface TraceAnalysisResult {
  facts: MemoryFact[];
  errors: string[];
}

export interface ExtractedFact {
  type: MemoryType;
  content: string;
  confidence: "high" | "medium" | "low";
}

// ─── Trace Analyzer ──────────────────────────────────────────────────

/**
 * Analyze a session trace and extract memory facts.
 *
 * Extracts conservative structural facts and writes them to the pending
 * review queue. This path intentionally makes no outbound model call:
 * session-completion work runs outside the turn's sensitivity/consent route.
 * Model-assisted extraction can be added later only through an explicitly
 * approved gateway callback.
 *
 * @param sessionTrace - The session log entries
 * @param sessionId - The session ID for provenance
 * @returns Analysis result with extracted facts and any errors
 */
export async function analyzeSessionTrace(
  sessionTrace: any[],
  sessionId: string,
): Promise<TraceAnalysisResult> {
  const facts: MemoryFact[] = [];
  const errors: string[] = [];

  // Build a compact summary of the session for the extraction LLM
  const traceSummary = buildTraceSummary(sessionTrace);

  // Keep the summary construction above as the input boundary for a future
  // explicitly approved extractor. For now, the safe default is structural
  // extraction only; it is deterministic, local, and still provenance-linked.
  if (!traceSummary.trim()) {
    errors.push("Session trace contained no extractable events");
  }
  const structuralFacts = structuralExtraction(sessionTrace, sessionId);
  for (const fact of structuralFacts) {
    await appendMemoryFact(fact);
    facts.push(fact);
  }

  return { facts, errors };
}

/**
 * Build a compact summary of the session trace for the extraction LLM.
 */
function buildTraceSummary(trace: any[]): string {
  const userInputs = trace
    .filter((e) => e.type === "user_input")
    .map((e) => e.data?.content || "")
    .filter(Boolean);

  const toolCalls = trace
    .filter((e) => e.type === "tool_call")
    .map((e) => e.data?.toolName || "")
    .filter(Boolean);

  const errors = trace
    .filter((e) => e.type === "api_error" || e.type === "tool_error")
    .map((e) => e.data?.error || e.data?.message || "")
    .filter(Boolean);

  return [
    `User requests: ${userInputs.length}`,
    ...userInputs.map((u) => `  - ${u.substring(0, 200)}`),
    "",
    `Tools used: ${toolCalls.length}`,
    ...toolCalls.map((t) => `  - ${t}`),
    "",
    `Errors encountered: ${errors.length}`,
    ...errors.map((e) => `  - ${e.substring(0, 200)}`),
  ].join("\n");
}

/**
 * Fallback structural extraction without LLM.
 * Extracts basic patterns from the session trace.
 */
function structuralExtraction(trace: any[], sessionId: string): MemoryFact[] {
  const facts: MemoryFact[] = [];

  // Extract tool usage patterns
  const toolCounts: Record<string, number> = {};
  for (const entry of trace) {
    if (entry.type === "tool_call") {
      const name = entry.data?.toolName || "";
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
  }

  const topTools = Object.entries(toolCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count}x)`);

  if (topTools.length > 0) {
    facts.push(
      createMemoryFact({
        type: "code_behavior",
        content: `Session used tools: ${topTools.join(", ")}`,
        source_session: sessionId,
        confidence: "low",
        privacy: "project",
      }),
    );
  }

  // Extract error patterns
  const errors = trace
    .filter((e) => e.type === "api_error" || e.type === "tool_error")
    .map((e) => e.data?.error || e.data?.message || "")
    .filter(Boolean);

  if (errors.length > 0) {
    facts.push(
      createMemoryFact({
        type: "error_pattern",
        content: `Session encountered ${errors.length} error(s): ${errors[0].substring(0, 200)}`,
        source_session: sessionId,
        confidence: "low",
        privacy: "project",
      }),
    );
  }

  return facts;
}