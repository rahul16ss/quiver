/**
 * Model Provider Abstraction — EPIC 2, Part 2.A
 *
 * The provider layer handles transport, auth, streaming, cancellation,
 * rate limits, token counting, and provider-specific error handling.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  displayName: string;
  providerId: string;
  contextWindowTokens: number;
  supportsTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsImages: boolean;
  supportsStreaming: boolean;
  supportsReasoningSummaries: boolean;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
}

export interface ChatRequest {
  model: string;
  messages: any[];
  tools?: any[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ModelEvent {
  type:
    | "text_delta"
    | "tool_call_start"
    | "tool_call_delta"
    | "tool_call_end"
    | "done"
    | "error"
    | "unsupported"
    | "reasoning_delta";
  content?: string;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArguments?: string;
  toolCallIndex?: number;
  error?: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** For "unsupported" events: the raw event data that couldn't be classified. */
  rawEvent?: unknown;
  /** For "unsupported" events: a human-readable description of what was received. */
  rawDescription?: string;
  /** For "reasoning_delta" events: the reasoning/thinking content (not persisted). */
  reasoning?: string;
}

export interface TokenCountInput {
  model: string;
  messages: any[];
}

export interface TokenCountResult {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Provider Interface ──────────────────────────────────────────────

export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  getModelInfo(modelId: string): Promise<ModelInfo>;
  streamChat(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
  countTokens?(input: TokenCountInput): Promise<TokenCountResult>;
}

// ─── Total Event Classification Helper ────────────────────────────────
//
// Inspired by os-june's total classifyHermesEvent function: every raw
// frame maps to exactly one event, and unknown frames become a visible
// "unsupported" event rather than vanishing. This makes debugging provider
// issues much easier — the user sees what the provider sent that Quiver
// didn't understand, instead of silent data loss.
//
// License note: This is original Quiver code (Apache-2.0). The concept of
// total event classification is a general software engineering practice.
// os-june (MIT) applies it to Hermes agent runtime frames.

/**
 * Describe an unknown SSE chunk in human-readable form.
 * This is used for "unsupported" events so the user can see what the
 * provider sent that Quiver didn't understand.
 */
export function describeUnknownChunk(chunk: unknown): string {
  if (chunk === null || chunk === undefined) {
    return "Empty chunk (null/undefined)";
  }
  if (typeof chunk === "string") {
    return `Non-JSON chunk: "${chunk.slice(0, 200)}"`;
  }
  if (typeof chunk === "object") {
    const obj = chunk as Record<string, any>;
    // Try to identify common provider-specific fields
    const keys = Object.keys(obj).slice(0, 10);
    const hasChoices = Array.isArray(obj.choices);
    const hasDelta = hasChoices && obj.choices[0]?.delta;
    const hasUsage = !!obj.usage;
    const hasError = !!obj.error;

    if (hasError) {
      return `Provider error in chunk: ${JSON.stringify(obj.error).slice(0, 200)}`;
    }
    if (hasChoices && !hasDelta && !obj.choices[0]?.finish_reason) {
      return `Chunk with choices but no delta or finish_reason: keys=[${keys.join(",")}]`;
    }
    if (!hasChoices) {
      return `Chunk without choices array: keys=[${keys.join(",")}]`;
    }
    return `Unknown chunk structure: keys=[${keys.join(",")}]`;
  }
  return `Unknown chunk type: ${typeof chunk}`;
}

// ─── Provider Registry ───────────────────────────────────────────────

import { config } from "../config.js";

/**
 * OpenAI-compatible provider (works with Ollama, OpenRouter, etc.)
 */
export class OpenAICompatibleProvider implements ModelProvider {
  id: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(id: string, baseUrl: string, apiKey: string) {
    this.id = id;
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
      });
      if (!response.ok) return [];
      const data: any = await response.json();
      return (data.data || []).map((m: any) => this.parseModelInfo(m));
    } catch {
      return [];
    }
  }

  async getModelInfo(modelId: string): Promise<ModelInfo> {
    // Try to fetch from /models endpoint, fall back to defaults
    const models = await this.listModels();
    const found = models.find((m) => m.id === modelId);
    if (found) return found;

    // Default model info
    return {
      id: modelId,
      displayName: modelId,
      providerId: this.id,
      contextWindowTokens: config.maxContextTokens,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsImages: false,
      supportsStreaming: true,
      supportsReasoningSummaries: false,
    };
  }

  async *streamChat(
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent> {
    // ── Timeout protection ──────────────────────────────────────────────
    // Without timeouts, a stalled API or a model processing a huge context
    // hangs the agent forever — the user sees no output and kills the process.
    // Two timeouts: connection (45s) + stream stall (120s no data mid-stream).
    const CONNECTION_TIMEOUT_MS = 45_000;
    const STREAM_STALL_TIMEOUT_MS = 120_000;

    const timeoutController = new AbortController();
    const onExternalAbort = () => timeoutController.abort();
    signal.addEventListener("abort", onExternalAbort);

    let connectionTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => {
        timeoutController.abort(new Error("Connection timeout (45s)"));
      },
      CONNECTION_TIMEOUT_MS,
    );

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        timeoutController.abort(new Error("Stream stall timeout (120s)"));
      }, STREAM_STALL_TIMEOUT_MS);
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          tools: request.tools,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens,
          stream: true,
        }),
        signal: timeoutController.signal,
      });
    } catch (err: any) {
      if (connectionTimer) clearTimeout(connectionTimer);
      if (stallTimer) clearTimeout(stallTimer);
      signal.removeEventListener("abort", onExternalAbort);
      if (err.name === "AbortError") {
        yield {
          type: "error",
          error: signal.aborted
            ? "Request cancelled"
            : "Connection timeout — model API did not respond in 45s",
        };
      } else {
        yield { type: "error", error: `Connection failed: ${err.message}` };
      }
      return;
    }

    // Connection succeeded — clear connection timer, start stall timer
    if (connectionTimer) {
      clearTimeout(connectionTimer);
      connectionTimer = null;
    }
    resetStallTimer();

    if (!response.ok) {
      if (stallTimer) clearTimeout(stallTimer);
      signal.removeEventListener("abort", onExternalAbort);
      const errorText = await response.text();
      yield {
        type: "error",
        error: `Provider error ${response.status}: ${errorText}`,
      };
      return;
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      if (stallTimer) clearTimeout(stallTimer);
      signal.removeEventListener("abort", onExternalAbort);
      yield { type: "error", error: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let finishReasonEmitted = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Reset stall timer on every chunk — only fires if NO data for 120s
        resetStallTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            // Only yield a done event if we haven't already yielded one from
            // a finish_reason chunk. If finish_reason was already sent (e.g.
            // "length" or "stop"), the done event was already emitted and we
            // must NOT overwrite it with a synthetic "stop" — that would mask
            // truncation (finish_reason: "length") in the agent's recovery
            // logic.
            if (!finishReasonEmitted) {
              yield { type: "done", finishReason: "stop" };
            }
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content) {
              yield { type: "text_delta", content: delta.content };
            }

            // ── Reasoning / chain-of-thought tokens ─────────────────────
            // GLM-5.2 and other models send delta.reasoning (or
            // delta.reasoning_content) for chain-of-thought tokens. Per
            // US-2.2 (HIDDEN-COT-NOT-PERSISTED), these must NOT be
            // accumulated into assistantContent, displayed, or logged.
            // We yield a reasoning_delta event so the agent loop can
            // silently consume it without persisting it.
            if (delta?.reasoning) {
              yield { type: "reasoning_delta", reasoning: delta.reasoning };
            }
            if (delta?.reasoning_content) {
              yield {
                type: "reasoning_delta",
                reasoning: delta.reasoning_content,
              };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === "number" ? tc.index : 0;
                if (tc.function?.name) {
                  yield {
                    type: "tool_call_start",
                    toolCallId: tc.id,
                    toolCallName: tc.function.name,
                    toolCallIndex: idx,
                  };
                }
                if (tc.function?.arguments) {
                  yield {
                    type: "tool_call_delta",
                    toolCallId: tc.id,
                    toolCallArguments: tc.function.arguments,
                    toolCallIndex: idx,
                  };
                }
              }
            }

            if (parsed.choices?.[0]?.finish_reason) {
              finishReasonEmitted = true;
              yield {
                type: "done",
                finishReason: parsed.choices[0].finish_reason,
                usage: parsed.usage
                  ? {
                      promptTokens: parsed.usage.prompt_tokens || 0,
                      completionTokens: parsed.usage.completion_tokens || 0,
                      totalTokens: parsed.usage.total_tokens || 0,
                    }
                  : undefined,
              };
            }
            // ── Total event classification ──────────────────────────────
            // Every SSE chunk must map to exactly one event. If the chunk
            // parsed as JSON but didn't match any known pattern (no
            // delta.content, no delta.reasoning, no delta.tool_calls, no
            // finish_reason), it is an unknown event — yield it as
            // "unsupported" so the agent can log it and the user can see
            // it, rather than silently dropping it. This is inspired by
            // os-june's total classifyHermesEvent function where unknown
            // frames become a visible "unsupported" event instead of
            // vanishing.
            if (
              delta?.content === undefined &&
              !delta?.reasoning &&
              !delta?.reasoning_content &&
              !delta?.tool_calls &&
              !parsed.choices?.[0]?.finish_reason
            ) {
              const desc = describeUnknownChunk(parsed);
              yield {
                type: "unsupported",
                rawEvent: parsed,
                rawDescription: desc,
              };
            }
          } catch (parseErr: any) {
            // Malformed JSON chunk — yield as unsupported so it's visible
            // rather than silently swallowed. This makes debugging provider
            // issues much easier.
            yield {
              type: "unsupported",
              rawEvent: data,
              rawDescription: `Malformed JSON in SSE chunk: ${parseErr.message}`,
            };
          }
        }
      }
    } catch (err: any) {
      // Stream read was aborted (timeout or external signal)
      if (err.name === "AbortError") {
        yield {
          type: "error",
          error: signal.aborted
            ? "Request cancelled"
            : "Stream stalled — no data for 120s",
        };
      } else {
        yield { type: "error", error: `Stream error: ${err.message}` };
      }
    }
    // ── Cleanup timers ───────────────────────────────────────────────────
    if (stallTimer) clearTimeout(stallTimer);
    signal.removeEventListener("abort", onExternalAbort);
  }

  // ── Total event classification helper ──────────────────────────────
  // Describes an unknown SSE chunk in human-readable form for the
  // "unsupported" event. This makes debugging provider issues easier —
  // the user can see exactly what the provider sent that Quiver didn't
  // understand, rather than having chunks silently vanish.

  private parseModelInfo(raw: any): ModelInfo {
    return {
      id: raw.id || raw.name || "unknown",
      displayName: raw.id || raw.name || "unknown",
      providerId: this.id,
      contextWindowTokens: raw.context_length || config.maxContextTokens,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsImages: false,
      supportsStreaming: true,
      supportsReasoningSummaries: false,
    };
  }
}

// ─── Provider Factory ────────────────────────────────────────────────

/**
 * Get the active model provider based on config.
 */
export function getActiveProvider(): ModelProvider {
  const baseUrl = config.llmBaseUrl;
  const apiKey = config.llmApiKey;
  return new OpenAICompatibleProvider("default", baseUrl, apiKey);
}

/**
 * Get the LOCAL model provider (US-17.17 / SPEC §4.3 high-sensitivity escape
 * hatch). Returns null if no local endpoint is configured — callers MUST refuse
 * the turn rather than fall back to the cloud endpoint for high-sensitivity
 * content (SPEC §11.2).
 */
export function getLocalProvider(): ModelProvider | null {
  if (!config.localLlmBaseUrl) return null;
  return new OpenAICompatibleProvider(
    "local",
    config.localLlmBaseUrl,
    config.llmApiKey, // single API key (US-1.3); local Ollama ignores it
  );
}

/**
 * Get the vision model provider (for vision fallback routing).
 */
export function getVisionProvider(): ModelProvider | null {
  if (!config.visionModelName) return null;
  return new OpenAICompatibleProvider(
    "vision",
    config.visionModelBaseUrl,
    config.visionModelApiKey,
  );
}
