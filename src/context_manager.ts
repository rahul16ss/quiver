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
 * 1. Summarization: Uses an LLM call to generate a real summary of old
 *    messages. The summary preserves key information (session intent,
 *    artifacts created, decisions made, next steps). The original
 *    conversation is written to a file for reference.
 *
 * 2. Context offloading: Large tool results are saved to files and
 *    replaced in the conversation with file path references + previews.
 *    The agent can re-read the file if it needs the full content.
 *
 * Both are user-controllable via the /compact command and automatic
 * thresholds. The user can see exactly what was compacted and recover
 * it from the filesystem.
 */

const OFFLOAD_THRESHOLD_CHARS = 80000; // ~20K tokens
const COMPACTION_TRIGGER_FRACTION = 0.85;
const COMPACTION_KEEP_FRACTION = 0.10;
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
 * Generate a summary of old messages using an LLM call.
 * This is the "in-context summary" part — it replaces the old messages
 * with a structured summary that preserves key information.
 */
async function generateSummary(
  messages: Message[],
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<string> {
  // Build the conversation text for summarization
  const conversationText = messages
    .map((m) => {
      const text = getMessageText(m);
      const role = m.role.toUpperCase();
      if (m.tool_calls && m.tool_calls.length > 0) {
        const toolNames = m.tool_calls.map((tc) => tc.function.name).join(", ");
        return `${role}: ${text}\n[Tool calls: ${toolNames}]`;
      }
      if (m.role === "tool") {
        return `TOOL_RESULT (${m.name}): ${text.substring(0, 500)}${text.length > 500 ? "..." : ""}`;
      }
      return `${role}: ${text}`;
    })
    .join("\n\n");

  const summaryPrompt = `Summarize the following conversation between a user and an AI coding agent. Preserve:
1. Session intent — what the user asked for and why
2. Key decisions made — architectural choices, approaches selected, trade-offs
3. Artifacts created or modified — files written, tools created, configs changed
4. Current state — what's done, what's in progress, what's blocked
5. Important context — file paths, function names, error messages that are still relevant
6. Next steps — what the agent was about to do or should do next

Be concise but complete. The summary should let the agent continue working as if it remembers the conversation.

CONVERSATION TO SUMMARIZE:
${conversationText}`;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a conversation summarizer. Create a structured summary that preserves all actionable information.",
          },
          { role: "user", content: summaryPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      // C1: bound the compaction call so a stalled LLM endpoint cannot hang
      // the agent forever mid-session. The stream timeouts (US-17.2) only
      // cover streamChat(); this is a separate one-shot fetch. On timeout we
      // fall through to the structural fallback summary (caught below).
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`Summary generation failed: ${response.status}`);
    }

    const data: any = await response.json();
    const summary = data.choices?.[0]?.message?.content;
    if (!summary) {
      throw new Error("No summary content in response");
    }
    return summary;
  } catch (error: any) {
    // Fallback: create a simple structural summary without LLM
    return generateFallbackSummary(messages);
  }
}

/**
 * Fallback summary when LLM call fails — extracts key information
 * structurally without requiring a model call.
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

  return `[Fallback Summary — LLM summarization failed]
Session intent: ${lastUserText}
Messages: ${messages.length} total (${userMessages.length} user, ${toolCalls.length} assistant with tools, ${toolResults.length} tool results)
Tools used: ${Array.from(toolsUsed).join(", ") || "none"}
Note: The full conversation was saved to a file. Use view_file to read it if needed.`;
}

/**
 * Perform context compaction with LLM-powered summarization.
 *
 * 1. Save the original conversation to a file (filesystem preservation)
 * 2. Generate an LLM summary of old messages
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
  const oldMessages = nonSystemMessages.slice(0, -keepRecent);
  let recentMessages = nonSystemMessages.slice(-keepRecent);

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

  // 1. Save original conversation to file
  const savedTo = await saveConversationBeforeCompaction(messages, sessionId);

  // 2. Generate LLM summary of old messages
  const summary = await generateSummary(
    oldMessages,
    config.llmModelName,
    config.llmApiKey,
    config.llmBaseUrl,
  );

  // 3. Rebuild messages: system + summary + recent
  messages.length = 0;
  messages.push(...systemMessages);
  messages.push({
    role: "system",
    content: `[Context Compacted — ${oldMessages.length} messages summarized]\n\nThe full conversation was saved to: ${savedTo}\n\nYou can read it with view_file if you need specific details from earlier in the conversation.\n\nSUMMARY OF PREVIOUS CONVERSATION:\n${summary}`,
  });
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