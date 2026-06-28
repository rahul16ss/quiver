/**
 * Deterministic Prompt Assembly — US-11.1
 *
 * Prompt payloads are assembled in a deterministic sequence:
 *   1. System identity
 *   2. Safety policy
 *   3. Adapter instructions
 *   4. Tool instructions
 *   5. Memory context
 *   6. Project context
 *   7. Conversation summary
 *   8. Recent messages
 *   9. Current user request
 *
 * HUD displays included sections, token footprint per section, active model/adapter,
 * and budgets.
 */

import type { HarnessAdapter, PromptAssemblyInput } from "../adapters/types.js";
import type { ModelInfo } from "../providers/types.js";
import { SECURITY_PREAMBLE } from "../prompts/security.js";
import { readReviewedMemoryFacts } from "../memory/schema.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface PromptSection {
  name: string;
  content: string;
  tokenEstimate: number;
  included: boolean;
}

export interface AssembledPrompt {
  systemPrompt: string;
  sections: PromptSection[];
  totalTokenEstimate: number;
}

// ─── Reviewed Memory Wiring (US-12.2) ──────────────────────────────────
// Only accepted (reviewed) memory facts are eligible for the model context.
// The pending review queue's "accept" action flips a fact to reviewed; this
// loader is what makes that acceptance actually reach the active prompt.
export async function loadReviewedMemoryContext(): Promise<string> {
  try {
    const facts = await readReviewedMemoryFacts();
    if (!facts || facts.length === 0) return "";
    const lines = facts
      .filter((f) => f.privacy !== "secret")
      .map((f) => `- [${f.type}${f.confidence ? `/${f.confidence}` : ""}] ${f.content}`);
    return lines.length ? `Reviewed memory facts:\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

// ─── Prompt Assembler ─────────────────────────────────────────────────

/**
 * Assemble a system prompt from structured input in a deterministic sequence.
 *
 * @param input - The structured prompt assembly input
 * @param adapter - The active harness adapter
 * @param model - The active model info
 * @returns Assembled prompt with per-section token estimates
 */
export function assemblePrompt(
  input: PromptAssemblyInput,
  adapter: HarnessAdapter,
  model: ModelInfo,
): AssembledPrompt {
  const sections: PromptSection[] = [];

  // 1. System identity
  sections.push({
    name: "System Identity",
    content: input.identity,
    tokenEstimate: adapter.estimateTokensFallback(input.identity),
    included: !!input.identity,
  });

  // 2. Safety policy (includes prompt injection defense)
  const safetyContent = [input.safetyPolicy, SECURITY_PREAMBLE].filter(Boolean).join("\n\n");
  sections.push({
    name: "Safety Policy",
    content: safetyContent,
    tokenEstimate: adapter.estimateTokensFallback(safetyContent),
    included: !!safetyContent,
  });

  // 3. Adapter instructions
  sections.push({
    name: "Adapter Instructions",
    content: input.adapterInstructions,
    tokenEstimate: adapter.estimateTokensFallback(input.adapterInstructions),
    included: !!input.adapterInstructions,
  });

  // 4. Tool instructions
  sections.push({
    name: "Tool Instructions",
    content: input.toolInstructions,
    tokenEstimate: adapter.estimateTokensFallback(input.toolInstructions),
    included: !!input.toolInstructions,
  });

  // 5. Memory context
  sections.push({
    name: "Memory Context",
    content: input.memoryContext,
    tokenEstimate: adapter.estimateTokensFallback(input.memoryContext),
    included: !!input.memoryContext,
  });

  // 6. Project context
  sections.push({
    name: "Project Context",
    content: input.projectContext,
    tokenEstimate: adapter.estimateTokensFallback(input.projectContext),
    included: !!input.projectContext,
  });

  // 7. Conversation summary
  sections.push({
    name: "Conversation Summary",
    content: input.conversationSummary,
    tokenEstimate: adapter.estimateTokensFallback(input.conversationSummary),
    included: !!input.conversationSummary,
  });

  // 8. Recent messages (tracked as a section for HUD display, but content
  //    is part of the conversation buffer, not the system prompt)
  sections.push({
    name: "Recent Messages",
    content: "",
    tokenEstimate: 0,
    included: false, // Not part of system prompt — part of conversation buffer
  });

  // 9. Current user request (tracked as a section for HUD display, but
  //    content is the latest user message in the conversation buffer)
  sections.push({
    name: "Current User Request",
    content: "",
    tokenEstimate: 0,
    included: false, // Not part of system prompt — part of conversation buffer
  });

  // Build the system prompt from included sections
  const includedSections = sections.filter((s) => s.included);
  const systemPrompt = includedSections
    .map((s) => s.content)
    .join("\n\n---\n\n");

  const totalTokenEstimate = includedSections.reduce((sum, s) => sum + s.tokenEstimate, 0);

  return {
    systemPrompt,
    sections,
    totalTokenEstimate,
  };
}

/**
 * Format the prompt assembly for HUD display.
 * Shows included sections, token footprint per section, and total.
 */
export function formatPromptForHUD(assembled: AssembledPrompt): string {
  const lines: string[] = [];
  lines.push("Context Manifest:");
  lines.push("");

  for (const section of assembled.sections) {
    const status = section.included ? "✓" : "—";
    const tokens = section.included ? `${section.tokenEstimate} tok` : "excluded";
    lines.push(`  ${status} ${section.name.padEnd(25)} ${tokens}`);
  }

  lines.push("");
  lines.push(`  Total: ${assembled.totalTokenEstimate} tokens (estimated)`);

  return lines.join("\n");
}