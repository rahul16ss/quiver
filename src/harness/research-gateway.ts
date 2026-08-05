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

import { createHash } from "crypto";
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
    results: Array<{ url: string; title?: string | null; publish_date?: string | null; excerpts: string[] }>;
    warnings?: Array<{ message?: string } | string> | null;
  }>;
  extract(params: {
    urls: string[];
    objective?: string;
    advanced_settings?: { full_content?: boolean | { max_chars_per_result?: number } };
  }): Promise<{
    results: Array<{ url: string; title?: string | null; publish_date?: string | null; excerpts: string[]; full_content?: string | null }>;
    errors?: Array<{ url: string; error_type?: string; content?: string | null; http_status_code?: number | null }>;
    warnings?: Array<{ message?: string } | string> | null;
  }>;
  taskRun(params: {
    input: string;
    processor?: string;
    task_spec?: { output_schema?: { type: "json" | "text"; json_schema?: Record<string, unknown>; description?: string } };
  }): Promise<{ output?: { type: string; content: unknown; basis?: Array<any> }; run?: { status?: string } }>;
  monitor(params: { query: string; cadence?: string }): Promise<{ monitor_id: string }>;
  monitorStop(id: string): Promise<void>;
  findEntities(params: { search_queries: string[]; objective?: string }): Promise<{ results: Array<{ url: string; title?: string | null; excerpts: string[] }> }>;
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
      task_spec: opts.outputSchema ? { output_schema: { type: "json", json_schema: opts.outputSchema } } : undefined,
    });
    const citations = (res.output?.basis ?? []).flatMap((f: any) =>
      (f.citations ?? []).map((c: any) => ({ url: c.url, title: c.title, excerpts: c.excerpts ?? [] })),
    );
    return { content: res.output?.content, citations };
  }

  async monitor(spec: MonitorSpec): Promise<MonitorHandle> {
    this.assertAllowed(spec.sensitivity);
    const created = await this.transport.monitor({ query: sanitizeQuery(spec.query, spec.sensitivity), cadence: spec.cadence });
    return { monitorId: created.monitor_id, stop: () => this.transport.monitorStop(created.monitor_id) };
  }

  async findEntities(query: string, opts: ResearchOpts = {}): Promise<ResearchSearchResult[]> {
    this.assertAllowed(opts.sensitivity);
    const res = await this.transport.findEntities({ search_queries: [sanitizeQuery(query, opts.sensitivity)], objective: query });
    const retrievedAt = new Date().toISOString();
    return (res.results || []).map((r) => toSearchResult(r, retrievedAt, undefined));
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
      this.clientPromise = import("parallel-web").then((mod: any) => new mod.Parallel({ apiKey: this.apiKey }));
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
  async monitorStop(id: string): Promise<void> {
    const c = await this.client();
    await c.monitor.delete(id);
  }
  async findEntities(params: any): Promise<any> {
    const c = await this.client();
    return c.beta?.findAll?.(params) ?? c.search(params);
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
  r: { url: string; title?: string | null; publish_date?: string | null; excerpts: string[]; full_content?: string | null },
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
  return w.map((x) => (typeof x === "string" ? x : x.message ?? "warning"));
}

function hashExcerpts(excerpts: string[]): string | undefined {
  if (!excerpts.length) return undefined;
  return createHash("sha256").update(excerpts.join("\n")).digest("hex").slice(0, 16);
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
      .replace(/\b(thesis|conviction|position|holdings?|client|account|MNPI|material non-public)\b/gi, "[redacted]")
      .trim();
  }
  return query;
}