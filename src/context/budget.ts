/**
 * Model-Aware Token Budgeting — US-11.2 / US-3.3
 *
 * Every model has a configured context window limit C_max.
 * Token counting uses model-specific tokenizers when available; otherwise
 * conservative estimation is used.
 *
 * Compaction triggers when:
 *   T_sys + T_mem + T_tools + T_buf + T_reserve > 0.85 × C_max
 *
 * A hard stop blocks submission if payload exceeds limits.
 */

import type { HarnessAdapter } from "../adapters/types.js";
import type { ModelInfo } from "../providers/types.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface TokenBudget {
  system: number;      // T_sys — system prompt tokens
  memory: number;      // T_mem — memory context tokens
  tools: number;       // T_tools — tool definitions tokens
  buffer: number;      // T_buf — conversation buffer tokens
  reserve: number;    // T_reserve — reserved for model output
  total: number;      // Sum of all above
  maxContext: number;  // C_max — model context window
  compactionThreshold: number; // 0.85 × C_max
  utilization: number; // total / maxContext (0-1)
  needsCompaction: boolean;
  exceedsLimit: boolean;
}

export interface BudgetSection {
  name: string;
  tokens: number;
  maxTokens?: number;
}

// ─── Budget Calculation ──────────────────────────────────────────────

const COMPACTION_FRACTION = 0.85;
const RESERVE_FRACTION = 0.15; // Reserve 15% for model output

/**
 * Calculate the token budget for the current context.
 *
 * @param params - The token counts for each section
 * @param model - The active model info
 * @param adapter - The active harness adapter
 * @returns Token budget with compaction/limit flags
 */
export function calculateBudget(
  params: {
    systemPrompt: string;
    memoryContext: string;
    toolDefinitions: string;
    conversationBuffer: string;
  },
  model: ModelInfo,
  adapter: HarnessAdapter,
): TokenBudget {
  const maxContext = model.contextWindowTokens || 120000;

  const system = adapter.estimateTokensFallback(params.systemPrompt);
  const memory = adapter.estimateTokensFallback(params.memoryContext);
  const tools = adapter.estimateTokensFallback(params.toolDefinitions);
  const buffer = adapter.estimateTokensFallback(params.conversationBuffer);
  const reserve = Math.floor(maxContext * RESERVE_FRACTION);

  const total = system + memory + tools + buffer + reserve;
  const compactionThreshold = Math.floor(maxContext * COMPACTION_FRACTION);

  return {
    system,
    memory,
    tools,
    buffer,
    reserve,
    total,
    maxContext,
    compactionThreshold,
    utilization: total / maxContext,
    needsCompaction: total > compactionThreshold,
    exceedsLimit: total > maxContext,
  };
}

/**
 * Format the token budget for HUD display.
 */
export function formatBudgetForHUD(budget: TokenBudget): string {
  const pct = Math.round(budget.utilization * 100);
  const bar = createProgressBar(budget.utilization);

  const lines: string[] = [
    `Token Budget: ${bar} ${pct}% (${budget.total.toLocaleString()} / ${budget.maxContext.toLocaleString()})`,
    "",
    `  System:     ${budget.system.toLocaleString()} tok`,
    `  Memory:     ${budget.memory.toLocaleString()} tok`,
    `  Tools:      ${budget.tools.toLocaleString()} tok`,
    `  Buffer:     ${budget.buffer.toLocaleString()} tok`,
    `  Reserve:    ${budget.reserve.toLocaleString()} tok (output)`,
    "",
  ];

  if (budget.needsCompaction) {
    lines.push(`  Compaction threshold reached (${Math.round(COMPACTION_FRACTION * 100)}%)`);
  }
  if (budget.exceedsLimit) {
    lines.push(`  ✗ Context limit exceeded — submission blocked`);
  }

  return lines.join("\n");
}

/**
 * Create a visual progress bar for token utilization.
 */
function createProgressBar(utilization: number, width: number = 20): string {
  const filled = Math.round(utilization * width);
  const empty = width - filled;

  let bar = "";
  if (utilization < 0.85) {
    bar = "\x1b[32m"; // Green
  } else if (utilization < 1.0) {
    bar = "\x1b[33m"; // Yellow
  } else {
    bar = "\x1b[31m"; // Red
  }

  bar += "█".repeat(filled) + "░".repeat(empty) + "\x1b[0m";
  return bar;
}

/**
 * Get the sections that should be compacted first (by priority).
 * Memory and conversation buffer are compacted before system/tools.
 */
export function getCompactionPriority(budget: TokenBudget): BudgetSection[] {
  return [
    { name: "Conversation Buffer", tokens: budget.buffer },
    { name: "Memory Context", tokens: budget.memory },
    { name: "Tool Definitions", tokens: budget.tools },
    { name: "System Prompt", tokens: budget.system },
  ].sort((a, b) => b.tokens - a.tokens);
}

/**
 * Check if a hard stop should block submission.
 */
export function shouldBlockSubmission(budget: TokenBudget): boolean {
  return budget.exceedsLimit;
}

/**
 * Get the compaction trigger fraction.
 */
export function getCompactionFraction(): number {
  return COMPACTION_FRACTION;
}