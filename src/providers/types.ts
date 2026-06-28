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
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done" | "error";
  content?: string;
  toolCallId?: string;
  toolCallName?: string;
  toolCallArguments?: string;
  error?: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
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
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  countTokens?(input: TokenCountInput): Promise<TokenCountResult>;
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

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: "error", error: `Provider error ${response.status}: ${errorText}` };
      return;
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { type: "done", finishReason: "stop" };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            yield { type: "text_delta", content: delta.content };
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name && !tc.id) {
                yield {
                  type: "tool_call_start",
                  toolCallId: tc.id,
                  toolCallName: tc.function.name,
                };
              }
              if (tc.function?.arguments) {
                yield {
                  type: "tool_call_delta",
                  toolCallId: tc.id,
                  toolCallArguments: tc.function.arguments,
                };
              }
            }
          }

          if (parsed.choices?.[0]?.finish_reason) {
            yield {
              type: "done",
              finishReason: parsed.choices[0].finish_reason,
              usage: parsed.usage ? {
                promptTokens: parsed.usage.prompt_tokens || 0,
                completionTokens: parsed.usage.completion_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              } : undefined,
            };
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

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