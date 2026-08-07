import { promises as fs } from "fs";
import * as path from "path";
import { config } from "./config.js";
import { getProjectSessionsDir } from "./paths.js";
import type { Message } from "./agent.js";

/**
 * Context management primitives for very long conversations.
 *
 * Philosophy: "Your harness, your memory" — no state on the model's side.
 * Everything is saved to files the user owns and can inspect.
 *
 * Two primitives:
 *
 * 1. Summarization: Generates a structural summary of old messages without
 *    making an auxiliary model call. The summary preserves enough information
 *    to navigate the archived transcript. The original conversation is
 *    written to a file for reference.
 *
 * 2. Context offloading: Large tool results are saved to files and
 *    replaced in the conversation with file path references + previews.
 *    The agent can re-read the file if it needs the full content.
 *
 * Both are user-controllable via the /compact command and automatic
 * thresholds. The user can see exactly what was compacted and recover
 * it from the filesystem. Any future model-assisted summary must be routed
 * through the normal sensitivity and consent path; this module deliberately
 * has no hidden outbound model call.
 */

const OFFLOAD_THRESHOLD_CHARS = 80000; // ~20K tokens
const COMPACTION_TRIGGER_FRACTION = 0.85;
const COMPACTION_KEEP_FRACTION = 0.1;
const COMPACTION_MIN_MESSAGES = 6;

/**
 * Estimate token count (rough heuristic: ~4 chars per token).
 */
function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

/**
 * Extract text content from a message (handles string and array content).
 */
function getMessageText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join(" ");
  }
  return "";
}

/**
 * Estimate total tokens in the conversation.
 */
export function estimateConversationTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(getMessageText(msg));
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.arguments);
      }
    }
  }
  return total;
}

/**
 * Get the path for saving compacted conversation history.
 */
function getCompactionDir(): string {
  return path.join(getProjectSessionsDir(), "compacted");
}

/**
 * Save the original conversation to a file before compaction.
 * This is the "filesystem preservation" part — the user can always
 * recover the full conversation from this file.
 */
async function saveConversationBeforeCompaction(
  messages: Message[],
  sessionId: string,
): Promise<string> {
  const dir = getCompactionDir();
  await fs.mkdir(dir, { recursive: true });
  const filename = `${sessionId}_compaction_${Date.now()}.json`;
  const filepath = path.join(dir, filename);

  const serializable = messages.map((m) => ({
    role: m.role,
    content: getMessageText(m),
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  }));

  await fs.writeFile(filepath, JSON.stringify(serializable, null, 2), "utf8");
  return filepath;
}

/**
 * Generate a compact structural summary without requiring a model call.
 * Keeping this deterministic is intentional: compaction runs before the next
 * turn's sensitivity/consent decision and must never silently send the old
 * transcript to a second endpoint.
 */
function generateFallbackSummary(messages: Message[]): string {
  const userMessages = messages.filter((m) => m.role === "user");
  const toolCalls = messages.filter((m) => m.role === "assistant" && m.tool_calls);
  const toolResults = messages.filter((m) => m.role === "tool");

  const toolsUsed = new Set<string>();
  toolCalls.forEach((m) => {
    m.tool_calls?.forEach((tc) => toolsUsed.add(tc.function.name));
  });

  const lastUserMsg = userMessages[userMessages.length - 1];
  const lastUserText = lastUserMsg ? getMessageText(lastUserMsg).substring(0, 200) : "";

  return `[Structural Summary — no auxiliary model call]
Session intent: ${lastUserText}
Messages: ${messages.length} total (${userMessages.length} user, ${toolCalls.length} assistant with tools, ${toolResults.length} tool results)
Tools used: ${Array.from(toolsUsed).join(", ") || "none"}
Note: The full conversation was saved to a file. Use view_file to read it if needed.`;
}

/**
 * Perform context compaction with a deterministic structural summary.
 *
 * 1. Save the original conversation to a file (filesystem preservation)
 * 2. Generate a structural summary without an auxiliary model call
 * 3. Replace old messages with the summary
 * 4. Keep recent messages intact
 *
 * @param messages The current message array (modified in place)
 * @param keepRecent Number of recent messages to keep
 * @param sessionId Session ID for file naming
 * @returns Object with compaction details
 */
export async function compactWithSummarization(
  messages: Message[],
  keepRecent: number,
  sessionId: string,
): Promise<{
  removedCount: number;
  summary: string;
  savedTo: string;
  tokensBefore: number;
  tokensAfter: number;
}> {
  if (messages.length <= keepRecent + 1) {
    return {
      removedCount: 0,
      summary: "",
      savedTo: "",
      tokensBefore: 0,
      tokensAfter: 0,
    };
  }

  const tokensBefore = estimateConversationTokens(messages);

  // Find system messages (keep them)
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  if (nonSystemMessages.length <= keepRecent) {
    return {
      removedCount: 0,
      summary: "",
      savedTo: "",
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  // Split into old (to summarize) and recent (to keep)
  const oldMessages = nonSystemMessages.slice(0, nonSystemMessages.length - keepRecent);
  let recentMessages = nonSystemMessages.slice(nonSystemMessages.length - keepRecent);

  // Don't start recent messages with orphaned tool messages
  while (
    recentMessages.length > 0 &&
    recentMessages[0].role === "tool" &&
    !recentMessages.some(
      (m) =>
        m.role === "assistant" &&
        m.tool_calls?.some((tc) => tc.id === recentMessages[0].tool_call_id),
    )
  ) {
    recentMessages = recentMessages.slice(1);
  }

  // Safety net: orphan-tool trim consumed everything — decline.
  if (recentMessages.length === 0) {
    return {
      removedCount: 0,
      summary: "",
      savedTo: "",
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  // 1. Save original conversation to file
  const savedTo = await saveConversationBeforeCompaction(messages, sessionId);

  // 2. Generate a local structural summary. Do not make an auxiliary model
  //    call here: the next turn's sensitivity and consent gates have not run yet.
  const summary = generateFallbackSummary(oldMessages);

  // 3. Rebuild messages: merge summary into the first system message (avoid
  //    doubling system messages — many providers reject multiple system
  //    messages, which was the root cause of the "Invalid count value: -7"
  //    crash on the post-compaction turn).
  messages.length = 0;
  const summaryContent = `[Context Compacted — ${oldMessages.length} messages summarized]\n\nThe full conversation was saved to: ${savedTo}\n\nYou can read it with view_file if you need specific details from earlier in the conversation.\n\nSUMMARY OF PREVIOUS CONVERSATION:\n${summary}`;
  if (systemMessages.length > 0) {
    messages.push({
      role: "system",
      content:
        (typeof systemMessages[0].content === "string"
          ? systemMessages[0].content
          : getMessageText(systemMessages[0])) +
        "\n\n" +
        summaryContent,
    });
  } else {
    messages.push({ role: "system", content: summaryContent });
  }
  messages.push(...recentMessages);

  const tokensAfter = estimateConversationTokens(messages);
  const removedCount = oldMessages.length;

  return {
    removedCount,
    summary,
    savedTo,
    tokensBefore,
    tokensAfter,
  };
}

export interface CompactionProposal {
  needed: boolean;
  summary: string;
  removedCount: number;
  savedTo: string;
  tokensBefore: number;
  tokensAfter: number;
  newMessages: Message[];
  keptRecent: number;
}

/**
 * Propose a compaction WITHOUT mutating the conversation (SPEC §7.3 consent):
 * save the original (full history preserved regardless of the decision), generate
 * a structural summary, and build the would-be compacted message array. Decline → the
 * live conversation is untouched; the saved copy is the accessible full history.
 */
export async function proposeCompaction(
  messages: Message[],
  keepRecent: number,
  sessionId: string,
): Promise<CompactionProposal> {
  const empty: CompactionProposal = {
    needed: false,
    summary: "",
    removedCount: 0,
    savedTo: "",
    tokensBefore: 0,
    tokensAfter: 0,
    newMessages: [],
    keptRecent: 0,
  };
  if (messages.length <= keepRecent + 1) return empty;
  const tokensBefore = estimateConversationTokens(messages);
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  // Guard: if there aren't enough non-system messages to both summarize and
  // keep, compaction is a no-op. Without this, slice(0, -keepRecent) returns
  // [] and we'd emit a "0 messages summarized" system message — inconsistent
  // state that can corrupt the next model call.
  if (nonSystemMessages.length <= keepRecent) {
    return { ...empty, tokensBefore, tokensAfter: tokensBefore };
  }
  const oldMessages = nonSystemMessages.slice(0, nonSystemMessages.length - keepRecent);
  let recentMessages = nonSystemMessages.slice(nonSystemMessages.length - keepRecent);
  while (
    recentMessages.length > 0 &&
    recentMessages[0].role === "tool" &&
    !recentMessages.some(
      (m) =>
        m.role === "assistant" &&
        m.tool_calls?.some((tc) => tc.id === recentMessages[0].tool_call_id),
    )
  ) {
    recentMessages = recentMessages.slice(1);
  }
  // Safety net: if the orphan-tool trim consumed all recent messages, there
  // is nothing left to keep — decline rather than emit a summary-only result.
  if (recentMessages.length === 0) {
    return { ...empty, tokensBefore, tokensAfter: tokensBefore };
  }
  const savedTo = await saveConversationBeforeCompaction(messages, sessionId);
  const summary = generateFallbackSummary(oldMessages);
  const summaryContent =
    "[Context Compacted \u2014 " +
    oldMessages.length +
    " messages summarized]\n\n" +
    "The full conversation was saved to: " +
    savedTo +
    "\n\n" +
    "You can read it with view_file if you need specific details from earlier in the conversation.\n\n" +
    "SUMMARY OF PREVIOUS CONVERSATION:\n" +
    summary;
  // Merge the summary into the FIRST system message rather than pushing a
  // second one. Many OpenAI-compatible endpoints reject
  // requests with multiple system messages or a system message after user
  // turns — this was the root cause of the "Invalid count value: -7" crash.
  const newMessages: Message[] = [];
  if (systemMessages.length > 0) {
    const mergedSystem: Message = {
      role: "system",
      content:
        (typeof systemMessages[0].content === "string"
          ? systemMessages[0].content
          : getMessageText(systemMessages[0])) +
        "\n\n" +
        summaryContent,
    };
    newMessages.push(mergedSystem);
    // Drop any additional original system messages (rare; they were likely
    // already concatenated by the prompt assembler).
  } else {
    newMessages.push({ role: "system", content: summaryContent });
  }
  newMessages.push(...recentMessages);
  return {
    needed: true,
    summary,
    removedCount: oldMessages.length,
    savedTo,
    tokensBefore,
    tokensAfter: estimateConversationTokens(newMessages),
    newMessages,
    keptRecent: recentMessages.length,
  };
}

/** Apply a compaction proposal: replace the live message array in place. */
export function applyCompaction(messages: Message[], proposal: CompactionProposal): void {
  messages.length = 0;
  messages.push(...proposal.newMessages);
}

/**
 * Offload large tool results to files, replacing them in the conversation
 * with file path references + previews.
 *
 * This keeps the active context small without losing information.
 * The agent can re-read the file if it needs the full content.
 *
 * @param messages The current message array (modified in place)
 * @param sessionId Session ID for file naming
 * @returns Number of tool results offloaded
 */
export async function offloadLargeToolResults(
  messages: Message[],
  sessionId: string,
): Promise<number> {
  let offloaded = 0;
  const dir = path.join(getProjectSessionsDir(), "offloaded");
  await fs.mkdir(dir, { recursive: true });

  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.content) continue;

    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (content.length <= OFFLOAD_THRESHOLD_CHARS) continue;

    // Save the full content to a file
    const filename = `${sessionId}_offload_${Date.now()}_${offloaded}.txt`;
    const filepath = path.join(dir, filename);
    await fs.writeFile(filepath, content, "utf8");

    // Replace with a reference + preview
    const previewLines = content.split("\n").slice(0, 10).join("\n");
    msg.content = `[Offloaded to file: ${filepath}]\n\nPreview (first 10 lines):\n${previewLines}\n...\n\nUse view_file to read the full content if needed.`;
    offloaded++;
  }

  return offloaded;
}

/**
 * Check if the conversation needs compaction based on token threshold.
 *
 * @param messages Current message array
 * @returns True if compaction should be triggered
 */
export function needsCompaction(messages: Message[]): boolean {
  const maxTokens = config.maxContextTokens;
  if (maxTokens <= 0) return false;

  const totalTokens = estimateConversationTokens(messages);
  const threshold = Math.floor(maxTokens * COMPACTION_TRIGGER_FRACTION);

  return totalTokens > threshold;
}

/**
 * Calculate how many recent messages to keep during compaction.
 */
export function calculateKeepRecent(messages: Message[]): number {
  const maxTokens = config.maxContextTokens;
  const keepTokens = Math.floor(maxTokens * COMPACTION_KEEP_FRACTION);

  // Walk backwards to find how many messages fit in keepTokens
  let tokens = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(getMessageText(messages[i]));
    if (tokens + msgTokens > keepTokens) break;
    tokens += msgTokens;
    count++;
  }

  return Math.max(count, COMPACTION_MIN_MESSAGES);
}
