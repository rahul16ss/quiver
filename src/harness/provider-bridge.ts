/**
 * QuiverOpenRouterProvider — Phase 2 caller-migration bridge (ADR-001).
 *
 * Adapts `ChatOpenRouter` to the legacy `ModelProvider` interface so the
 * existing agent loop can use OpenRouter as the sole cloud gateway WITHOUT a
 * rewrite. Every request enforces the Quiver policy:
 *   provider.zdr=true, data_collection="deny", require_parameters=true,
 *   allow_fallbacks=false, an explicit approved provider/model route from a
 *   certified ModelProfile, no automatic router.
 *
 * Additive: not wired into `getActiveProvider()` yet. The final flip (returning
 * this adapter from `getActiveProvider()` for cloud configs) is the gated last
 * step of Phase 2, after the checker-owned spec assertions are updated.
 */

import type { ModelProvider, ModelInfo, ChatRequest, ModelEvent } from "../providers/types.js";
import { config } from "../config.js";
import type { ModelProfileRegistry, ModelProfile } from "./model-profile.js";

// ─── Injectable chat model (so the bridge is testable) ────────────────

export interface ChatModelLike {
  stream(messages: unknown[], options: Record<string, unknown>): AsyncIterable<unknown>;
}

export interface ProviderBridgeOptions {
  apiKey: string;
  profiles: ModelProfileRegistry;
  /** Profile slug to use for cloud requests. */
  profileSlug: string;
  siteUrl?: string;
  siteName?: string;
}

export class QuiverOpenRouterProvider implements ModelProvider {
  id = "openrouter";
  private profile: ModelProfile;
  private chatModelPromise: Promise<ChatModelLike> | null = null;

  constructor(
    private opts: ProviderBridgeOptions,
    private chatModelFactory?: (opts: ProviderBridgeOptions) => Promise<ChatModelLike>,
  ) {
    const p = opts.profiles.get(opts.profileSlug);
    if (!p) throw new Error(`QuiverOpenRouterProvider: unknown profile '${opts.profileSlug}'`);
    if (!p.zdrEligible) throw new Error(`QuiverOpenRouterProvider: profile '${opts.profileSlug}' is not ZDR-eligible.`);
    this.profile = p;
  }

  private async chatModel(): Promise<ChatModelLike> {
    if (!this.chatModelPromise) {
      this.chatModelPromise = this.chatModelFactory
        ? this.chatModelFactory(this.opts)
        : defaultChatModelFactory(this.opts);
    }
    return this.chatModelPromise;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: this.profile.modelSlug,
        displayName: this.profile.modelSlug,
        providerId: this.id,
        contextWindowTokens: this.profile.contextWindowTokens,
        supportsTools: this.profile.supportsToolCalling,
        supportsParallelToolCalls: this.profile.supportsToolCalling,
        supportsImages: this.profile.testedNativeMimeTypes.some((m) => m.startsWith("image/")),
        supportsStreaming: true,
        supportsReasoningSummaries: false,
      },
    ];
  }

  async getModelInfo(modelId: string): Promise<ModelInfo> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId) ?? models[0];
  }

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // Enforce policy on every request via the provider prefs passed to the call.
    const providerPrefs = {
      order: this.profile.providerOrder,
      allow_fallbacks: false as const,
      require_parameters: true as const,
      data_collection: "deny" as const,
      zdr: true as const,
    };
    const invocation: Record<string, unknown> = {
      provider: providerPrefs,
      signal,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    };
    if (request.tools?.length) invocation.tools = request.tools;

    let model: ChatModelLike;
    try {
      model = await this.chatModel();
    } catch (err: any) {
      yield { type: "error", error: `OpenRouter client init failed: ${err.message}` };
      return;
    }

    try {
      const stream = model.stream(request.messages, invocation);
      for await (const chunk of stream) {
        for (const ev of translateChunk(chunk)) yield ev;
      }
      yield { type: "done", finishReason: "stop" };
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        yield { type: "error", error: "Request cancelled" };
      } else {
        yield { type: "error", error: `OpenRouter stream error: ${err.message}` };
      }
    }
  }
}

// ─── Chunk translation ────────────────────────────────────────────────

function translateChunk(chunk: unknown): ModelEvent[] {
  const c = chunk as any;
  const events: ModelEvent[] = [];
  const content = c?.content;
  if (typeof content === "string" && content) {
    events.push({ type: "text_delta", content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as any).text === "string") {
        events.push({ type: "text_delta", content: (part as any).text });
      }
    }
  }
  // Reasoning / chain-of-thought (not persisted).
  if (c?.reasoning) events.push({ type: "reasoning_delta", reasoning: c.reasoning });
  if (c?.reasoning_content) events.push({ type: "reasoning_delta", reasoning: c.reasoning_content });

  const chunks: any[] = c?.tool_call_chunks ?? c?.tool_calls ?? [];
  for (const tc of chunks) {
    const idx = typeof tc.index === "number" ? tc.index : 0;
    if (tc.name) {
      events.push({ type: "tool_call_start", toolCallId: tc.id, toolCallName: tc.name, toolCallIndex: idx });
    }
    if (tc.args) {
      events.push({ type: "tool_call_delta", toolCallId: tc.id, toolCallArguments: tc.args, toolCallIndex: idx });
    }
  }
  return events;
}

// ─── Default ChatOpenRouter factory (lazy import) ─────────────────────

async function defaultChatModelFactory(opts: ProviderBridgeOptions): Promise<ChatModelLike> {
  const mod: any = await import("@langchain/openrouter");
  const ChatOpenRouter = mod.ChatOpenRouter;
  const chat = new ChatOpenRouter({
    apiKey: opts.apiKey,
    model: opts.profiles.get(opts.profileSlug)!.modelSlug,
    siteUrl: opts.siteUrl,
    siteName: opts.siteName,
  });
  return {
    async *stream(messages: unknown[], options: Record<string, unknown>): AsyncIterable<unknown> {
      const bound = options.tools ? chat.bindTools(options.tools) : chat;
      yield* bound.stream(messages, options);
    },
  };
}