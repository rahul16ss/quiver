/**
 * ModelClient — Phase 2 (ADR-001).
 *
 * `QuiverOpenRouterClient` is the sole cloud model gateway. It wraps
 * `ChatOpenRouter` (from `@langchain/openrouter`) but enforces Quiver policy on
 * every eligible cloud request:
 *   - provider.zdr = true
 *   - provider.data_collection = "deny"
 *   - provider.require_parameters = true
 *   - an explicit approved provider/model route (from a certified ModelProfile)
 *   - no unapproved fallback endpoints (allow_fallbacks = false)
 *   - no automatic model router (no `models` list, no `route: "fallback"`)
 *   - request cancellation, timeout and retry budgets
 *   - usage + provider metadata capture without prompt-content logging
 *
 * The installed `ChatOpenRouter` (0.4.5) natively expresses `provider.zdr`,
 * `data_collection`, `require_parameters`, `allow_fallbacks`, `order`, and the
 * `file-parser` plugin with `pdf.engine: "native"`. For native file content
 * parts, the transport builds the OpenRouter-specific `file` content part — the
 * smallest possible passthrough; no second cloud stack, no LangChain fork.
 *
 * Policy enforcement is pure and unit-testable via an injectable `Transport`.
 * The real `ChatOpenRouterTransport` lazily imports `ChatOpenRouter` so the
 * module loads in CI without network credentials. `LocalModelClient` handles
 * private models; high-sensitivity policy fails closed if no approved local
 * route is configured and never falls back to OpenRouter.
 */

import type {
  ModelClient,
  ModelMessage,
  ModelResult,
  ModelProfileRef,
  RequestBudget,
  ContentPart,
} from "./interfaces.js";
import type { PolicyEngine, PolicyDecision } from "./interfaces.js";
import {
  ModelProfileRegistry,
  isCertifiedFor,
  type ModelProfile,
  type NativeMime,
} from "./model-profile.js";

// ─── Transport abstraction ────────────────────────────────────────────

/**
 * The minimal transport surface the policy core depends on. The real
 * implementation wraps ChatOpenRouter; tests inject a mock.
 */
export interface ModelTransport {
  invoke(request: TransportRequest): Promise<TransportResponse>;
}

export interface TransportRequest {
  model: string;
  provider: {
    order: string[];
    allow_fallbacks: false;
    require_parameters: true;
    data_collection: "deny";
    zdr: true;
  };
  messages: unknown[];
  tools?: unknown[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Strict JSON schema output, if the certified profile supports it. */
  responseFormat?: { type: "json_schema"; jsonSchema: Record<string, unknown> };
  /** Force native PDF parsing on a proven route. */
  plugins?: Array<{ id: "file-parser"; pdf?: { engine: "native" } }>;
  /** OpenRouter app attribution (no secrets). */
  siteUrl?: string;
  siteName?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TransportResponse {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string; passthrough?: Record<string, unknown> }>;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; provider?: Record<string, unknown>; costUsd?: number };
  finishReason?: string;
  /** The provider/model route actually used (from OpenRouter response metadata). */
  route: string;
}

// ─── QuiverOpenRouterClient ───────────────────────────────────────────

export class QuiverOpenRouterClient implements ModelClient {
  readonly id = "openrouter";
  readonly kind = "cloud" as const;

  constructor(
    private transport: ModelTransport,
    private profiles: ModelProfileRegistry,
    private policy: PolicyEngine,
    private opts: { siteUrl?: string; siteName?: string } = {},
  ) {}

  listProfiles(): ModelProfileRef[] {
    return this.profiles.list().map((p) => ({
      slug: p.slug,
      label: p.modelSlug,
      providerOrder: p.providerOrder,
      zdrEligible: p.zdrEligible,
      checkerEligible: p.checkerEligible,
    }));
  }

  async invoke(
    messages: ModelMessage[],
    options: {
      modelProfile: string;
      tools?: unknown[];
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      budget?: RequestBudget;
      strictOutput?: Record<string, unknown>;
      sensitivity?: import("./interfaces.js").SensitivityProfile;
    },
  ): Promise<ModelResult> {
    const profile = this.profiles.get(options.modelProfile);
    if (!profile) {
      throw new Error(`Unknown model profile: ${options.modelProfile}`);
    }
    if (!profile.zdrEligible) {
      throw new Error(`Profile ${profile.slug} is not ZDR-eligible; cloud egress refused.`);
    }

    // Policy gate: cloud inference for this sensitivity must be permitted.
    const sensitivity = options.sensitivity ?? "public";
    const decision = this.policy.decide({ kind: "model", sensitivity, route: profile.modelSlug });
    if (!decision.permitted) {
      throw new Error(`Policy refused model call: ${decision.reasons.join("; ")}`);
    }
    if (decision.enforcedRoute && decision.enforcedRoute !== "openrouter") {
      throw new Error(`Policy routed this request to '${decision.enforcedRoute}', not OpenRouter. Refusing cloud egress.`);
    }

    // Validate native file content parts against certification — fail closed.
    const nativeMimes = collectNativeMimes(messages);
    for (const mime of nativeMimes) {
      if (!isCertifiedFor(profile, mime)) {
        throw new Error(
          `Profile ${profile.slug} is not certified for native ingestion of ${mime}. ` +
            `Run the opt-in contract test; do not silently substitute OCR/text extraction.`,
        );
      }
      if (mime === "application/pdf" && profile.pdfEngine !== "native") {
        throw new Error(`Profile ${profile.slug} pdfEngine is not 'native'; refusing non-native PDF handling.`);
      }
      if (fileBytes(messages, mime) > profile.maxFileBytes) {
        throw new Error(`File exceeds profile maxFileBytes (${profile.maxFileBytes}).`);
      }
    }

    // Build the policy-enforced transport request.
    const signal = options.budget?.signal ?? maybeTimeout(options.budget?.timeoutMs);
    const req: TransportRequest = {
      model: profile.modelSlug,
      provider: {
        order: profile.providerOrder,
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
      },
      messages: messages.map(toTransportMessage),
      tools: options.tools,
      temperature: options.temperature,
      topP: options.topP,
      maxTokens: options.maxTokens,
      responseFormat:
        options.strictOutput && profile.supportsStrictOutput
          ? { type: "json_schema", jsonSchema: options.strictOutput }
          : undefined,
      plugins: nativeMimes.includes("application/pdf")
        ? [{ id: "file-parser", pdf: { engine: "native" } }]
        : undefined,
      siteUrl: this.opts.siteUrl,
      siteName: this.opts.siteName,
      signal,
      timeoutMs: options.budget?.timeoutMs,
    };

    const maxRetries = options.budget?.maxRetries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await this.transport.invoke(req);
        return {
          content: resp.content,
          toolCalls: resp.toolCalls,
          usage: resp.usage,
          finishReason: resp.finishReason,
          modelProfile: profile.slug,
          route: resp.route || profile.modelSlug,
        };
      } catch (err) {
        lastErr = err;
        // No retry on auth/policy (4xx) — fail fast.
        if (isAuthError(err)) break;
        if (attempt < maxRetries) await sleep(backoffMs(attempt));
      }
    }
    throw new Error(`Model invocation failed after ${maxRetries + 1} attempt(s): ${String((lastErr as Error)?.message ?? lastErr)}`);
  }
}

// ─── LocalModelClient ─────────────────────────────────────────────────

export class LocalModelClient implements ModelClient {
  readonly id = "local";
  readonly kind = "local" as const;

  constructor(
    private transport: ModelTransport,
    private profiles: ModelProfileRegistry,
  ) {}

  listProfiles(): ModelProfileRef[] {
    return this.profiles.list().map((p) => ({
      slug: p.slug,
      label: p.modelSlug,
      providerOrder: p.providerOrder,
      zdrEligible: p.zdrEligible,
      checkerEligible: p.checkerEligible,
    }));
  }

  async invoke(
    messages: ModelMessage[],
    options: {
      modelProfile: string;
      tools?: unknown[];
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      budget?: RequestBudget;
      strictOutput?: Record<string, unknown>;
    },
  ): Promise<ModelResult> {
    const profile = this.profiles.get(options.modelProfile);
    if (!profile) throw new Error(`Unknown local model profile: ${options.modelProfile}`);
    const signal = options.budget?.signal ?? maybeTimeout(options.budget?.timeoutMs);
    const resp = await this.transport.invoke({
      model: profile.modelSlug,
      // Local transports do not use OpenRouter provider prefs; pass through.
      provider: { order: profile.providerOrder, allow_fallbacks: false, require_parameters: true, data_collection: "deny", zdr: true },
      messages: messages.map(toTransportMessage),
      tools: options.tools,
      temperature: options.temperature,
      topP: options.topP,
      maxTokens: options.maxTokens,
      signal,
      timeoutMs: options.budget?.timeoutMs,
    });
    return {
      content: resp.content,
      toolCalls: resp.toolCalls,
      usage: resp.usage,
      finishReason: resp.finishReason,
      modelProfile: profile.slug,
      route: resp.route || "local",
    };
  }
}

// ─── Real ChatOpenRouter transport (lazy) ─────────────────────────────

/**
 * Thin adapter over `ChatOpenRouter`. Lazily imports the package so the module
 * loads in CI without network credentials. This is the only place that touches
 * LangChain directly; all policy lives in `QuiverOpenRouterClient`.
 */
export class ChatOpenRouterTransport implements ModelTransport {
  private clientPromise: Promise<any> | null = null;

  constructor(private apiKey: string, private opts: { siteUrl?: string; siteName?: string } = {}) {}

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import("@langchain/openrouter").then((mod: any) => {
        const ChatOpenRouter = mod.ChatOpenRouter;
        return new ChatOpenRouter({
          apiKey: this.apiKey,
          // Provider prefs are set per-request via invocation options below.
          siteUrl: this.opts.siteUrl,
          siteName: this.opts.siteName,
        });
      });
    }
    return this.clientPromise;
  }

  async invoke(request: TransportRequest): Promise<TransportResponse> {
    const client = await this.client();
    // Convert our TransportRequest into ChatOpenRouter invocation args.
    const lcMessages = request.messages;
    const invocation: Record<string, unknown> = {
      provider: request.provider,
      plugins: request.plugins,
    };
    if (request.tools) invocation.tools = request.tools;
    if (request.temperature !== undefined) invocation.temperature = request.temperature;
    if (request.topP !== undefined) invocation.topP = request.topP;
    if (request.maxTokens !== undefined) invocation.maxTokens = request.maxTokens;
    if (request.responseFormat) invocation.response_format = request.responseFormat;
    if (request.signal) invocation.signal = request.signal;
    if (request.timeoutMs) invocation.timeout = request.timeoutMs;

    const bound = request.tools ? client.bindTools(request.tools) : client;
    const result = await bound.invoke(lcMessages, invocation);
    const content = typeof result.content === "string" ? result.content : stringifyContent(result.content);
    const usage = result.usage_metadata
      ? {
          promptTokens: result.usage_metadata.input_tokens ?? 0,
          completionTokens: result.usage_metadata.output_tokens ?? 0,
          totalTokens: result.usage_metadata.total_tokens ?? 0,
          provider: result.response_metadata,
          costUsd: result.response_metadata?.cost,
        }
      : undefined;
    return {
      content,
      toolCalls: result.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
        passthrough: tc,
      })),
      usage,
      finishReason: result.response_metadata?.finish_reason,
      route: result.response_metadata?.model_name || request.model,
    };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function toTransportMessage(m: ModelMessage): unknown {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }
  // Convert ContentPart[] to OpenRouter content parts (smallest passthrough).
  const parts = m.content.map((p) => toContentPart(p));
  return { role: m.role, content: parts };
}

function toContentPart(p: ContentPart): unknown {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "image": {
      const data = typeof p.data === "string" ? p.data : p.data.toString("base64");
      return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${data}` } };
    }
    case "file": {
      // OpenRouter-native file content part (smallest passthrough).
      const data = typeof p.data === "string" ? Buffer.from(p.data, "base64") : p.data;
      return {
        type: "file",
        file: {
          filename: p.filename ?? "document",
          file_data: `data:${p.mimeType};base64,${data.toString("base64")}`,
        },
      };
    }
  }
}

function collectNativeMimes(messages: ModelMessage[]): NativeMime[] {
  const set = new Set<NativeMime>();
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "file" && isNativeMime(p.mimeType)) set.add(p.mimeType as NativeMime);
      }
    }
  }
  return Array.from(set);
}

function fileBytes(messages: ModelMessage[], mime: NativeMime): number {
  let total = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "file" && p.mimeType === mime) {
          total += typeof p.data === "string" ? Buffer.byteLength(p.data, "base64") : p.data.length;
        }
      }
    }
  }
  return total;
}

function isNativeMime(m: string): m is NativeMime {
  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/png",
    "image/jpeg",
  ].includes(m);
}

function stringifyContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("");
  }
  return String(content);
}

function maybeTimeout(timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

function isAuthError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /401|403|unauthor|forbidden|invalid api key/i.test(msg);
}

function backoffMs(attempt: number): number {
  return Math.min(2000, 200 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}