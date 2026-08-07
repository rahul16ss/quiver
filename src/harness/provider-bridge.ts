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
 * Wired into `getActiveProvider()` for configured OpenRouter cloud sessions.
 * In `profileSlug: "auto"` mode it routes each chat request through the
 * modality-aware ModelRouter and constructs the selected profile's model.
 */

import type { ModelProvider, ModelInfo, ChatRequest, ModelEvent } from "../providers/types.js";
import { config } from "../config.js";
import { ModalityRouter, type ModelRole } from "./model-router.js";
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
  private readonly router: ModalityRouter;
  private readonly chatModels = new Map<string, Promise<ChatModelLike>>();

  constructor(
    private opts: ProviderBridgeOptions,
    private chatModelFactory?: (opts: ProviderBridgeOptions) => Promise<ChatModelLike>,
  ) {
    this.router = new ModalityRouter(opts.profiles.list());
    const fallbackSlug = opts.profileSlug === "auto"
      ? this.router.route([{ role: "user", content: "" }], "maker", "public")
      : opts.profileSlug;
    const p = fallbackSlug ? opts.profiles.get(fallbackSlug) : undefined;
    if (!p) throw new Error(`QuiverOpenRouterProvider: unknown or unroutable profile '${opts.profileSlug}'`);
    if (!p.zdrEligible) throw new Error(`QuiverOpenRouterProvider: profile '${p.slug}' is not ZDR-eligible.`);
    this.profile = p;
  }

  private async chatModelFor(profile: ModelProfile): Promise<ChatModelLike> {
    const existing = this.chatModels.get(profile.slug);
    if (existing) return existing;
    const opts = { ...this.opts, profileSlug: profile.slug };
    const created = this.chatModelFactory
      ? this.chatModelFactory(opts)
      : defaultChatModelFactory(opts);
    this.chatModels.set(profile.slug, created);
    return created;
  }

  private profileForRequest(messages: unknown[], role: ModelRole = "maker"): ModelProfile {
    if (this.opts.profileSlug !== "auto") return this.profile;
    const normalized = messages.map((message: any) => ({
      role: message?.role ?? "user",
      content: Array.isArray(message?.content)
        ? message.content.map((part: any) => {
            if (part?.type === "file") {
              return { type: "file", mimeType: part.mimeType ?? part.file?.mime_type ?? "application/pdf", data: Buffer.alloc(0) };
            }
            if (part?.type === "image" || part?.type === "image_url") {
              return { type: "image", mimeType: part.mimeType ?? "image/png", data: Buffer.alloc(0) };
            }
            return { type: "text", text: String(part?.text ?? part ?? "") };
          })
        : String(message?.content ?? ""),
    }));
    const slug = this.router.route(normalized as any, role, "public");
    return slug ? (this.opts.profiles.get(slug) ?? this.profile) : this.profile;
  }

  async listModels(): Promise<ModelInfo[]> {
    const profiles = this.opts.profileSlug === "auto" ? this.opts.profiles.list() : [this.profile];
    return profiles.map((profile) => ({
      id: profile.modelSlug,
      displayName: profile.modelSlug,
      providerId: this.id,
      contextWindowTokens: profile.contextWindowTokens,
      supportsTools: profile.supportsToolCalling,
      supportsParallelToolCalls: profile.supportsToolCalling,
      supportsImages: profile.nativeFileInput || profile.testedNativeMimeTypes.some((m) => m.startsWith("image/")),
      supportsStreaming: true,
      supportsReasoningSummaries: false,
    }));
  }

  async getModelInfo(modelId: string): Promise<ModelInfo> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId) ?? models[0];
  }

  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const selected = this.profileForRequest(request.messages, "maker");
    const providerPrefs = {
      order: selected.providerOrder,
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
      model = await this.chatModelFor(selected);
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
      yield { type: "error", error: err?.name === "AbortError" || signal.aborted ? "Request cancelled" : `OpenRouter stream error: ${err.message}` };
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