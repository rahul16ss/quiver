/**
 * Automated Trace Analysis & Extraction — US-4.2
 *
 * Triggers a lightweight extraction LLM pass on session completion.
 * Extracts preferences, common errors, and project architecture facts.
 * New extracted memories enter a 'pending' state in the memory review queue.
 */

import { config } from "../config.js";
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
 * Feeds the session trace to a local or fast remote model to output
 * JSON facts, which are then written to the pending review queue.
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

  try {
    const extracted = await callExtractionLLM(traceSummary);

    for (const fact of extracted) {
      const memoryFact = createMemoryFact({
        type: fact.type,
        content: fact.content,
        source_session: sessionId,
        confidence: fact.confidence,
        privacy: "project",
      });
      await appendMemoryFact(memoryFact);
      facts.push(memoryFact);
    }
  } catch (error: any) {
    errors.push(`LLM extraction failed: ${error.message}`);

    // Fallback: structural extraction without LLM
    const structuralFacts = structuralExtraction(sessionTrace, sessionId);
    for (const fact of structuralFacts) {
      await appendMemoryFact(fact);
      facts.push(fact);
    }
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
 * Call the extraction LLM to extract facts from the session trace.
 */
async function callExtractionLLM(traceSummary: string): Promise<ExtractedFact[]> {
  const prompt = `Analyze the following session trace from an AI coding agent and extract memory-worthy facts.
Output a JSON array of facts with this shape:
[{"type": "workspace_fact" | "user_preference" | "code_behavior" | "architecture_note" | "error_pattern", "content": "...", "confidence": "high" | "medium" | "low"}]

Only extract facts that are:
1. Durable (will be useful in future sessions)
2. Specific (not generic programming knowledge)
3. Accurate (based on what actually happened in the trace)

SESSION TRACE:
${traceSummary}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.llmModelName,
        messages: [
          {
            role: "system",
            content: "You are a memory extraction assistant. Extract durable facts from agent session traces. Output only valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Extraction LLM failed: ${response.status}`);
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content || "[]";

    // Parse JSON from the response (handle markdown code blocks)
    const jsonStr = content
      .replace(/^```(?:json)?\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();

    return JSON.parse(jsonStr) as ExtractedFact[];
  } finally {
    clearTimeout(timeoutId);
  }
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