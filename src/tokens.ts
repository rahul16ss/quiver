/**
 * Token Counting — US-11.2 / US-3.3
 *
 * Token counting uses model-specific tokenizers (e.g. TikToken for GPT-4/Claude,
 * GLM tokenizers) when available; otherwise conservative estimation is used.
 *
 * Labels token counts as exact (when using native tokenizer) or estimated
 * (when using fallback tokenizer).
 */

import { config } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface TokenCountResult {
  tokens: number;
  exact: boolean;
  tokenizer: string;
}

export interface MessageTokenCount {
  role: string;
  tokens: number;
  exact: boolean;
}

// ─── Fallback Estimation ──────────────────────────────────────────────

/**
 * Conservative token estimation: ~4 chars per token.
 * This is the fallback when no native tokenizer is available.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

/**
 * Estimate tokens for a message (content + tool calls).
 */
export function estimateMessageTokens(message: any): number {
  let total = 0;

  if (typeof message.content === "string") {
    total += estimateTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") total += estimateTokens(part.text || "");
      else if (part.type === "image_url") total += 85; // Image tokens (rough estimate)
    }
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      total += estimateTokens(tc.function?.name || "");
      total += estimateTokens(tc.function?.arguments || "");
    }
  }

  // Overhead per message (role, formatting)
  total += 4;

  return total;
}

// ─── Native Tokenizer Integration ────────────────────────────────────

let tiktokenEncoder: any = null;
let tiktokenLoaded = false;

/**
 * Try to load TikToken for GPT-4/Claude models.
 * Returns true if loaded successfully.
 */
async function tryLoadTikToken(): Promise<boolean> {
  if (tiktokenLoaded) return tiktokenEncoder !== null;

  tiktokenLoaded = true;
  try {
    // Dynamic import — tiktoken may not be installed
    // @ts-ignore — optional dependency
    const tiktoken = await import("tiktoken");
    tiktokenEncoder = tiktoken.encoding_for_model("gpt-4");
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to load GLM tokenizer.
 */
async function tryLoadGLMTokenizer(): Promise<any> {
  try {
    // GLM tokenizer may be available as a separate package
    // @ts-ignore — optional dependency
    const glmTokenizer = await import("glm-tokenizer");
    return glmTokenizer;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Count tokens in a text string using the best available tokenizer.
 *
 * @param text - The text to count
 * @param model - The model name (determines tokenizer selection)
 * @returns Token count result with exact/estimated flag
 */
export async function countTokens(text: string, model?: string): Promise<TokenCountResult> {
  const modelName = (model || config.llmModelName).toLowerCase();

  // Try TikToken for GPT/Claude models
  if (modelName.includes("gpt") || modelName.includes("claude") || modelName.includes("openai")) {
    const loaded = await tryLoadTikToken();
    if (loaded && tiktokenEncoder) {
      try {
        const tokens = tiktokenEncoder.encode(text).length;
        return { tokens, exact: true, tokenizer: "tiktoken" };
      } catch {
        // Fall through to estimation
      }
    }
  }

  // Try GLM tokenizer for GLM models
  if (modelName.includes("glm")) {
    const glmTokenizer = await tryLoadGLMTokenizer();
    if (glmTokenizer) {
      try {
        const tokens = glmTokenizer.encode(text).length;
        return { tokens, exact: true, tokenizer: "glm" };
      } catch {
        // Fall through to estimation
      }
    }
  }

  // Fallback: conservative estimation
  return {
    tokens: estimateTokens(text),
    exact: false,
    tokenizer: "fallback",
  };
}

/**
 * Count tokens in a message array.
 *
 * @param messages - Array of messages
 * @param model - The model name
 * @returns Total token count and per-message breakdown
 */
export async function countMessageTokens(
  messages: any[],
  model?: string,
): Promise<{ total: number; exact: boolean; perMessage: MessageTokenCount[]; tokenizer: string }> {
  const perMessage: MessageTokenCount[] = [];
  let total = 0;
  let allExact = true;
  let tokenizer = "fallback";

  for (const msg of messages) {
    const result = await countTokens(
      typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || ""),
      model,
    );
    total += result.tokens;
    if (!result.exact) allExact = false;
    tokenizer = result.tokenizer;
    perMessage.push({ role: msg.role, tokens: result.tokens, exact: result.exact });
  }

  return { total, exact: allExact, perMessage, tokenizer };
}

/**
 * Format a token count for HUD display.
 * Shows whether the count is exact or estimated.
 */
export function formatTokenCount(result: TokenCountResult): string {
  const label = result.exact ? "exact" : "est";
  const tokenizerLabel = result.tokenizer === "fallback" ? "" : ` (${result.tokenizer})`;
  return `${result.tokens.toLocaleString()} tok [${label}]${tokenizerLabel}`;
}

/**
 * Check if a native tokenizer is available for the given model.
 */
export async function hasNativeTokenizer(model?: string): Promise<boolean> {
  const modelName = (model || config.llmModelName).toLowerCase();

  if (modelName.includes("gpt") || modelName.includes("claude") || modelName.includes("openai")) {
    return await tryLoadTikToken();
  }

  if (modelName.includes("glm")) {
    return (await tryLoadGLMTokenizer()) !== null;
  }

  return false;
}