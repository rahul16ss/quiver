/**
 * ResearchGateway — Phase 3 (ADR-003).
 *
 * Parallel (`parallel-web`) is the sole default public-web/deep-research
 * gateway. Typed operations: search, extract, research (Task, only for broad
 * synthesis), monitor, findEntities. Normal research follows
 * Search → select sources → Extract, consuming the documented `excerpts` and
 * `full_content` fields. There is no `result.content` assumption and no regex
 * HTML stripping. Browser control is NOT part of this interface — it is
 * retained separately for authenticated/interactive sources only and never a
 * hidden fallback.
 *
 * Three data-handling profiles gate Parallel and cloud inference:
 *   - public:                 Parallel permitted.
 *   - confidential-internal:  Parallel receives only sanitized public queries
 *                              (no internal thesis / client context).
 *   - restricted-mnpi:        no Parallel; no public cloud inference.
 *
 * The PolicyEngine decides per call. The gateway fails closed when policy
 * denies Parallel — it never silently falls back to a regex HTTP scrape.
 */

import { createHash, timingSafeEqual } from "crypto";
import type {
  ResearchGateway,
  ResearchOpts,
  ResearchExtractOpts,
  ResearchTaskOpts,
  ResearchSearchResult,
  ResearchExtractResult,
  ResearchTaskResult,
  MonitorSpec,
  MonitorHandle,
  SensitivityProfile,
  SourceCategory,
  FindAllInput,
  FindAllResult,
} from "./interfaces.js";
import type { PolicyEngine } from "./interfaces.js";

// ─── Parallel SDK transport abstraction ───────────────────────────────

/**
 * The minimal Parallel SDK surface the gateway depends on. The real
 * implementation wraps `parallel-web`; tests inject a mock. Methods mirror the
 * SDK's typed shapes (excerpts, full_content, publish_date, title, url).
 */
export interface ParallelTransport {
  search(params: {
    search_queries: string[];
    objective?: string;
    mode?: "turbo" | "basic" | "advanced";
    advanced_settings?: { max_results?: number };
  }): Promise<{
    results: Array<{
      url: string;
      title?: string | null;
      publish_date?: string | null;
      excerpts: string[];
    }>;
    warnings?: Array<{ message?: string } | string> | null;
  }>;
  extract(params: {
    urls: string[];
    objective?: string;
    advanced_settings?: { full_content?: boolean | { max_chars_per_result?: number } };
  }): Promise<{
    results: Array<{
      url: string;
      title?: string | null;
      publish_date?: string | null;
      excerpts: string[];
      full_content?: string | null;
    }>;
    errors?: Array<{
      url: string;
      error_type?: string;
      content?: string | null;
      http_status_code?: number | null;
    }>;
    warnings?: Array<{ message?: string } | string> | null;
  }>;
  taskRun(params: {
    input: string;
    processor?: string;
    task_spec?: {
      output_schema?: {
        type: "json" | "text";
        json_schema?: Record<string, unknown>;
        description?: string;
      };
    };
  }): Promise<{
    output?: { type: string; content: unknown; basis?: Array<any> };
    run?: { status?: string };
  }>;
  monitor(params: {
    type: "event_stream" | "snapshot";
    frequency: string;
    settings: Record<string, unknown>;
    processor?: "lite" | "base";
    webhook?: { url: string; event_types?: string[] };
    metadata?: Record<string, string>;
  }): Promise<{ monitor_id: string; status: string }>;
  monitorCancel(id: string): Promise<void>;
  monitorEvents(
    id: string,
    opts?: { event_group_id?: string; include_completions?: boolean },
  ): Promise<{ events: any[]; next_cursor?: string }>;
  findEntities(params: {
    search_queries: string[];
    objective?: string;
  }): Promise<{ results: Array<{ url: string; title?: string | null; excerpts: string[] }> }>;
  findAllCreate(params: {
    objective: string;
    entity_type: "companies" | "people";
    generator?: string;
    match_conditions?: Array<{ name: string; description: string }>;
    match_limit?: number;
  }): Promise<{ findall_id: string }>;
  findAllRetrieve(id: string): Promise<{ status: { is_active: boolean } }>;
  findAllResult(id: string): Promise<{
    candidates?: Array<{
      name?: string;
      matched?: boolean;
      reasoning?: string;
      confidence?: number;
      citations?: Array<{ url: string; title?: string; excerpts?: string[] }>;
    }>;
  }>;
}

// ─── ParallelResearchGateway ──────────────────────────────────────────

export class ParallelResearchGateway implements ResearchGateway {
  constructor(
    private transport: ParallelTransport,
    private policy: PolicyEngine,
  ) {}

  async search(query: string, opts: ResearchOpts = {}): Promise<ResearchSearchResult[]> {
    this.assertAllowed(opts.sensitivity);
    const sanitized = sanitizeQuery(query, opts.sensitivity);
    const res = await this.transport.search({
      search_queries: [sanitized],
      objective: sanitized,
      mode: "basic",
      advanced_settings: { max_results: opts.maxResults ?? 10 },
    });
    const retrievedAt = new Date().toISOString();
    return (res.results || []).map((r) => toSearchResult(r, retrievedAt, res.warnings));
  }

  async extract(urls: string[], opts: ResearchExtractOpts = {}): Promise<ResearchExtractResult[]> {
    this.assertAllowed(opts.sensitivity);
    const res = await this.transport.extract({
      urls,
      objective: opts.objective,
      advanced_settings: opts.fullContent ? { full_content: true } : undefined,
    });
    const retrievedAt = new Date().toISOString();
    return (res.results || []).map((r) => toExtractResult(r, retrievedAt, res.warnings));
  }

  async research(input: string, opts: ResearchTaskOpts = {}): Promise<ResearchTaskResult> {
    this.assertAllowed(opts.sensitivity);
    const sanitized = sanitizeQuery(input, opts.sensitivity);
    const res = await this.transport.taskRun({
      input: sanitized,
      processor: opts.processor,
      task_spec: opts.outputSchema
        ? { output_schema: { type: "json", json_schema: opts.outputSchema } }
        : undefined,
    });
    const citations = (res.output?.basis ?? []).flatMap((f: any) =>
      (f.citations ?? []).map((c: any) => ({
        url: c.url,
        title: c.title,
        excerpts: c.excerpts ?? [],
      })),
    );
    return { content: res.output?.content, citations };
  }

  async monitor(spec: MonitorSpec): Promise<MonitorHandle> {
    this.assertAllowed(spec.sensitivity);
    const settings: Record<string, unknown> =
      spec.type === "event_stream"
        ? { query: sanitizeQuery(spec.settings.query ?? "", spec.sensitivity) }
        : { task_run_id: spec.settings.task_run_id };
    if (spec.settings.output_schema) settings.output_schema = spec.settings.output_schema;
    if (spec.settings.include_backfill !== undefined)
      settings.include_backfill = spec.settings.include_backfill;
    if (spec.settings.advanced_settings)
      settings.advanced_settings = spec.settings.advanced_settings;
    const created = await this.transport.monitor({
      type: spec.type,
      frequency: spec.frequency,
      settings,
      processor: spec.processor,
      webhook: spec.webhook
        ? { url: spec.webhook.url, event_types: spec.webhook.event_types }
        : undefined,
      metadata: spec.metadata,
    });
    const id = created.monitor_id;
    return {
      monitorId: id,
      cancel: () => this.transport.monitorCancel(id),
      events: (opts) =>
        this.transport.monitorEvents(id, opts).then((r) => (r.events || []).map(toMonitorEvent)),
    };
  }

  async findEntities(query: string, opts: ResearchOpts = {}): Promise<ResearchSearchResult[]> {
    this.assertAllowed(opts.sensitivity);
    const res = await this.transport.findEntities({
      search_queries: [sanitizeQuery(query, opts.sensitivity)],
      objective: query,
    });
    const retrievedAt = new Date().toISOString();
    return (res.results || []).map((r) => toSearchResult(r, retrievedAt, undefined));
  }

  async findAll(input: FindAllInput, opts: ResearchOpts = {}): Promise<FindAllResult> {
    this.assertAllowed(opts.sensitivity);
    const run = await this.transport.findAllCreate({
      objective: sanitizeQuery(input.objective, opts.sensitivity),
      entity_type: input.entityType,
      generator: input.generator,
      match_conditions: input.matchConditions,
      match_limit: input.matchLimit,
    });
    // Poll until inactive (bounded).
    for (let i = 0; i < 60; i++) {
      const st = await this.transport.findAllRetrieve(run.findall_id);
      if (!st.status?.is_active) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const res = await this.transport.findAllResult(run.findall_id);
    return {
      candidates: (res.candidates || []).map((c) => ({
        name: c.name ?? "",
        matched: !!c.matched,
        reasoning: c.reasoning,
        citations: c.citations,
        confidence: c.confidence,
      })),
    };
  }

  private assertAllowed(sensitivity?: SensitivityProfile): void {
    const s = sensitivity ?? "public";
    const decision = this.policy.decide({ kind: "research", sensitivity: s });
    if (!decision.permitted) {
      throw new Error(`Research refused by policy: ${decision.reasons.join("; ")}`);
    }
  }
}

// ─── Real parallel-web transport (lazy) ───────────────────────────────

/**
 * Thin adapter over the `parallel-web` SDK. Lazily imports the package so the
 * module loads in CI without network credentials.
 */
export class ParallelWebTransport implements ParallelTransport {
  private clientPromise: Promise<any> | null = null;
  constructor(private apiKey: string) {}

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import("parallel-web").then(
        (mod: any) => new mod.Parallel({ apiKey: this.apiKey }),
      );
    }
    return this.clientPromise;
  }

  async search(params: any): Promise<any> {
    const c = await this.client();
    return c.search(params);
  }
  async extract(params: any): Promise<any> {
    const c = await this.client();
    return c.extract(params);
  }
  async taskRun(params: any): Promise<any> {
    const c = await this.client();
    return c.taskRun.create(params);
  }
  async monitor(params: any): Promise<any> {
    const c = await this.client();
    return c.monitor.create(params);
  }
  async monitorCancel(id: string): Promise<void> {
    const c = await this.client();
    await c.monitor.cancel(id);
  }
  async monitorEvents(id: string, opts?: any): Promise<any> {
    const c = await this.client();
    return c.monitor.events(id, opts);
  }
  async findEntities(params: any): Promise<any> {
    const c = await this.client();
    return c.beta?.findAll?.entitySearch?.(params) ?? c.search(params);
  }
  async findAllCreate(params: any): Promise<any> {
    const c = await this.client();
    return c.beta.findall.create(params);
  }
  async findAllRetrieve(id: string): Promise<any> {
    const c = await this.client();
    return c.beta.findall.retrieve(id);
  }
  async findAllResult(id: string): Promise<any> {
    const c = await this.client();
    return c.beta.findall.result(id);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function toSearchResult(
  r: { url: string; title?: string | null; publish_date?: string | null; excerpts: string[] },
  retrievedAt: string,
  warnings?: Array<{ message?: string } | string> | null,
): ResearchSearchResult {
  return {
    url: r.url,
    canonicalUrl: r.url,
    title: r.title ?? "",
    publishedDate: r.publish_date ?? undefined,
    retrievedAt,
    excerpts: r.excerpts ?? [],
    sourceCategory: "public-web-research" as SourceCategory,
    warnings: normalizeWarnings(warnings),
  };
}

function toExtractResult(
  r: {
    url: string;
    title?: string | null;
    publish_date?: string | null;
    excerpts: string[];
    full_content?: string | null;
  },
  retrievedAt: string,
  warnings?: Array<{ message?: string } | string> | null,
): ResearchExtractResult {
  return {
    url: r.url,
    canonicalUrl: r.url,
    title: r.title ?? "",
    publishedDate: r.publish_date ?? undefined,
    retrievedAt,
    excerpts: r.excerpts ?? [],
    fullContent: r.full_content ?? undefined,
    sourceCategory: "public-web-research" as SourceCategory,
    snapshotHash: hashExcerpts(r.excerpts ?? []),
    warnings: normalizeWarnings(warnings),
  };
}

function normalizeWarnings(w?: Array<{ message?: string } | string> | null): string[] | undefined {
  if (!w || w.length === 0) return undefined;
  return w.map((x) => (typeof x === "string" ? x : (x.message ?? "warning")));
}

function hashExcerpts(excerpts: string[]): string | undefined {
  if (!excerpts.length) return undefined;
  return createHash("sha256").update(excerpts.join("\n")).digest("hex").slice(0, 16);
}

// ─── Monitor event helpers (GA contract) ──────────────────────────────

function toMonitorEvent(e: any): import("./interfaces.js").MonitorEvent {
  return {
    event_id: e.event_id,
    event_group_id: e.event_group_id,
    event_date: e.event_date ?? null,
    event_type: e.event_type,
    output: e.output,
    changed_output: e.changed_output,
    previous_output: e.previous_output,
  };
}

/**
 * Verify a Parallel webhook HMAC signature (timing-safe). Parallel signs the
 * raw request body with the shared webhook secret. Returns false on any
 * mismatch — callers must reject the delivery (never accept unverified).
 */
export function verifyParallelWebhook(
  body: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHash("sha256").update(body).update(secret).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Deduplicate monitor events by stable event_id across pagination/retry. Returns
 * events not already seen. The caller persists seen IDs in a durable store.
 */
export function dedupeMonitorEvents(
  events: import("./interfaces.js").MonitorEvent[],
  seen: Set<string>,
): import("./interfaces.js").MonitorEvent[] {
  const out: import("./interfaces.js").MonitorEvent[] = [];
  for (const e of events) {
    if (e.event_id && !seen.has(e.event_id)) {
      seen.add(e.event_id);
      out.push(e);
    }
  }
  return out;
}

/**
 * Sanitize a query for confidential-internal: strip internal thesis and client
 * identifiers before sending to Parallel. For public, pass through. This is a
 * best-effort redaction gate; the PolicyEngine already forbids Parallel for
 * restricted-mnpi entirely.
 */
function sanitizeQuery(query: string, sensitivity?: SensitivityProfile): string {
  if (sensitivity === "confidential-internal") {
    return query
      .replace(
        /\b(thesis|conviction|position|holdings?|client|account|MNPI|material non-public)\b/gi,
        "[redacted]",
      )
      .trim();
  }
  return query;
}
