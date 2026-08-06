/**
 * Quiver Harness — narrow interfaces (Phase 1).
 *
 * These ten interfaces are the seams of the refactor. They are intentionally
 * narrow (not a general framework): each describes the minimum a concrete
 * implementation must provide so the control/knowledge/work-product/experience
 * planes can be wired with explicit constructors and small registries — no DI
 * framework (ADR-011).
 *
 * The interfaces are additive. Legacy modules (`src/providers`, `src/tools`,
 * `src/workflow`, `src/connectors`, `src/evidence`, `src/document`, `src/memory`,
 * `src/security`, `src/prompt`) remain in place and green until a later phase
 * migrates callers and removes the old path.
 *
 * Planes:
 *  1. Control plane   — ExecutionEngine, PolicyEngine, (GoalContract in
 *                       goal_contract.ts), checkpoints/approvals/resumability.
 *  2. Knowledge plane  — ResearchGateway, IntegrationBroker, StorageProvider
 *                       (read/knowledge side), ModelClient (inference egress).
 *  3. Work-product     — ArtifactRepository, OfficeEngine, StorageProvider
 *                       (commit side).
 *  4. Experience plane — (browser UI + launcher/CLI; Phase 8) TraceSink spans
 *                       all planes.
 */

// ─── Shared primitives ────────────────────────────────────────────────

import type { GoalContract } from "./goal-contract.js";

/** A content part for a model request (text, image, or native file). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: Buffer | string /* base64 */ }
  | { type: "file"; mimeType: string; data: Buffer; filename?: string };

/** A single message in a model conversation. */
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** For assistant tool calls / tool results (provider-specific echo bags). */
  toolCalls?: unknown[];
  toolCallId?: string;
  name?: string;
}

/** Usage + provider metadata captured without prompt-content logging. */
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** OpenRouter provider routing metadata (provider name, generation id, etc.). */
  provider?: Record<string, unknown>;
  costUsd?: number;
}

/** Outcome of a single model invocation. */
export interface ModelResult {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
    /** Opaque provider echo bag (transport concern only). */
    passthrough?: Record<string, unknown>;
  }>;
  usage?: ModelUsage;
  finishReason?: string;
  /** The certified ModelProfile slug actually used (after policy routing). */
  modelProfile: string;
  /** The provider/model route actually used. */
  route: string;
}

/** A request budget: cancellation, timeout and retry. */
export interface RequestBudget {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Max retries on transient errors (excludes 4xx auth/policy). */
  maxRetries?: number;
}

// ─── 1. ModelClient (knowledge plane — inference egress) ─────────────

/**
 * Inference egress. The only cloud implementation is `QuiverOpenRouterClient`
 * (ADR-001). A separate `LocalModelClient` handles private models. There is no
 * generic "any OpenAI-compatible endpoint" cloud client.
 */
export interface ModelClient {
  id: string;
  /** Whether this client is a cloud (egress) client or a local/private one. */
  readonly kind: "cloud" | "local";
  invoke(
    messages: ModelMessage[],
    options: {
      modelProfile: string;
      tools?: unknown[];
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      budget?: RequestBudget;
      /** Strict JSON schema output, if the certified profile supports it. */
      strictOutput?: Record<string, unknown>;
      /** Sensitivity profile for policy routing (cloud vs local). */
      sensitivity?: SensitivityProfile;
    },
  ): Promise<ModelResult>;
  /** List certified profiles this client can serve. */
  listProfiles(): ModelProfileRef[];
}

/** A reference to a certified ModelProfile (full record in model_profile.ts). */
export interface ModelProfileRef {
  slug: string;
  label: string;
  providerOrder: string[];
  zdrEligible: boolean;
  checkerEligible: boolean;
}

// ─── 2. ExecutionEngine (control plane) ──────────────────────────────

/**
 * Limited LangGraph substrate (ADR-002). Durable state, checkpoints,
 * resumability, timeouts and human interrupts. Wraps Quiver's existing tool
 * registry, policy checks, evidence layer, approvals and maker/checker logic
 * as graph nodes — does not adopt the full LangChain agent/tool ecosystem.
 */
export interface ExecutionEngine {
  /** Start (or resume) a goal-seeking run for a contract. */
  run(contract: GoalContract, options: RunOptions): Promise<RunOutcome>;
  /** Resume a paused/interrupted run from its checkpoint. */
  resume(runId: string, humanInput: unknown, options?: RunOptions): Promise<RunOutcome>;
  /** Read the current state of a run (for the experience plane). */
  inspect(runId: string): Promise<RunSnapshot | null>;
  /** Cancel a running run. */
  cancel(runId: string, reason?: string): Promise<void>;
}

/** A handle to a resolved GoalContract (full record in goal_contract.ts). */
export interface GoalContractHandle {
  runId: string;
  objective: string;
  requiredDeliverables: string[];
  definitionOfDone: string[];
  budgets: { costUsd?: number; timeMs?: number; iterations?: number };
  stopConditions: string[];
}

export interface RunOptions {
  budget?: RequestBudget;
  /** Called when the engine hits a human interrupt (approval gate). */
  onInterrupt?: (snapshot: RunSnapshot) => Promise<unknown>;
}

export interface RunSnapshot {
  runId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "blocked" | "cancelled";
  currentPhase: string;
  gapLedger: GapEntry[];
  pendingApprovals: PendingApproval[];
  stopReason?: string;
  /** Honest partial-completion summary — never "complete" when mandatory steps failed. */
  unresolved: string[];
}

export interface GapEntry {
  id: string;
  description: string;
  category: string;
  status: "open" | "in_progress" | "resolved" | "blocked";
  blocker?: string;
}

export interface PendingApproval {
  id: string;
  kind: "tool" | "commit" | "office_change" | "research_boundary" | "memory";
  summary: string;
  changeSet?: unknown;
}

export interface RunOutcome {
  runId: string;
  status: "completed" | "blocked" | "partial" | "failed" | "paused" | "cancelled";
  stopReason: string;
  unresolved: string[];
  artifacts: string[];
  /** Reproducible run record (evidence + lineage). */
  runRecord: Record<string, unknown>;
}

// ─── 3. ResearchGateway (knowledge plane — public web) ──────────────

/**
 * Parallel is the sole default public-web/deep-research gateway (ADR-003).
 * Browser control is NOT part of this interface — it is retained separately
 * for authenticated/interactive sources only and never a hidden fallback.
 */
export interface ResearchGateway {
  search(query: string, opts?: ResearchOpts): Promise<ResearchSearchResult[]>;
  extract(
    urls: string[],
    opts?: ResearchExtractOpts,
  ): Promise<ResearchExtractResult[]>;
  /** Task only for genuinely broad multi-source synthesis. */
  research(input: string, opts?: ResearchTaskOpts): Promise<ResearchTaskResult>;
  monitor(spec: MonitorSpec): Promise<MonitorHandle>;
  findEntities(query: string, opts?: ResearchOpts): Promise<ResearchSearchResult[]>;
  /** Discover + verify entities matching natural-language criteria (FindAll). */
  findAll(input: FindAllInput, opts?: ResearchOpts): Promise<FindAllResult>;
}

export interface FindAllInput {
  objective: string;
  entityType: "companies" | "people";
  matchConditions?: Array<{ name: string; description: string }>;
  generator?: "preview" | "base" | "core" | "pro";
  matchLimit?: number;
}

export interface FindAllResult {
  candidates: Array<{
    name: string;
    matched: boolean;
    reasoning?: string;
    citations?: Array<{ url: string; title?: string; excerpts?: string[] }>;
    confidence?: number;
  }>;
  cost?: { usd?: number; latencyMs: number };
}

export interface ResearchOpts {
  budget?: RequestBudget;
  /** Sensitivity profile gates what may be sent to Parallel. */
  sensitivity?: SensitivityProfile;
  maxResults?: number;
}

export interface ResearchExtractOpts extends ResearchOpts {
  /** Objective-driven extraction (guides what excerpts are returned). */
  objective?: string;
  /** Request full Markdown in addition to excerpts. */
  fullContent?: boolean;
}

export interface ResearchTaskOpts extends ResearchOpts {
  processor?: "lite" | "base" | "core" | "pro" | "ultra";
  outputSchema?: Record<string, unknown>;
}

export interface ResearchSearchResult {
  url: string;
  canonicalUrl: string;
  title: string;
  publisher?: string;
  publishedDate?: string;
  retrievedAt: string;
  excerpts: string[];
  /** Source category for lineage. */
  sourceCategory: SourceCategory;
  warnings?: string[];
  cost?: { usd?: number; latencyMs: number };
}

export interface ResearchExtractResult {
  url: string;
  canonicalUrl: string;
  title: string;
  publisher?: string;
  publishedDate?: string;
  retrievedAt: string;
  excerpts: string[];
  fullContent?: string;
  sourceCategory: SourceCategory;
  /** Snapshot hash where policy permits. */
  snapshotHash?: string;
  warnings?: string[];
  cost?: { usd?: number; latencyMs: number };
}

export interface ResearchTaskResult {
  content: unknown;
  citations: Array<{
    url: string;
    title?: string;
    excerpts: string[];
  }>;
  cost?: { usd?: number; latencyMs: number };
}

export interface MonitorSpec {
  /** event_stream (search query) or snapshot (task run output). */
  type: "event_stream" | "snapshot";
  /** GA frequency: '<n><h|d|w>' between 1h and 30d. */
  frequency: string;
  /** Type-specific settings: { query } for event_stream, { task_run_id } for snapshot. */
  settings: MonitorSettings;
  /** lite (default) or base (thorough). */
  processor?: "lite" | "base";
  /** Optional webhook for push delivery. */
  webhook?: MonitorWebhook;
  /** User metadata echoed in events (keys ≤16 chars, values ≤512). */
  metadata?: Record<string, string>;
  sensitivity?: SensitivityProfile;
}

export interface MonitorSettings {
  query?: string;
  task_run_id?: string;
  output_schema?: { type: "json"; json_schema: Record<string, unknown> };
  include_backfill?: boolean;
  advanced_settings?: {
    source_policy?: { include_domains?: string[]; exclude_domains?: string[]; after_date?: string };
    location?: string;
  };
}

export interface MonitorWebhook {
  url: string;
  event_types?: Array<"monitor.event.detected" | "monitor.execution.completed" | "monitor.execution.failed">;
}

export interface MonitorEvent {
  event_id: string;
  event_group_id: string;
  event_date?: string | null;
  event_type: "event_stream" | "snapshot" | "completion" | "error";
  output?: { type: string; content: unknown; basis?: any[] };
  changed_output?: unknown;
  previous_output?: unknown;
}

export interface MonitorHandle {
  monitorId: string;
  /** Cancel the monitor (GA lifecycle: status → cancelled; no delete op). */
  cancel(): Promise<void>;
  /** Retrieve events (newest first), paginated. */
  events(opts?: { event_group_id?: string; include_completions?: boolean }): Promise<MonitorEvent[]>;
}

// ─── 4. StorageProvider (work-product + knowledge planes) ────────────

/**
 * Versioned storage with honest conflict behavior (ADR-005). Separated from
 * Office manipulation. Implementations: Local, MicrosoftGraph, GoogleDrive.
 */
export interface StorageProvider {
  id: string;
  readonly kind: "local" | "microsoft-graph" | "google-drive";
  /** Capabilities honestly declared (not all providers support all ops). */
  capabilities(): StorageCapabilities;
  checkout(
    identity: StorageIdentity,
    opts?: StorageOpts,
  ): Promise<StorageCheckout>;
  metadata(identity: StorageIdentity, opts?: StorageOpts): Promise<StorageMetadata>;
  list(
    folder: StorageIdentity,
    opts?: StorageListOpts,
  ): Promise<StorageMetadata[]>;
  commit(
    workingCopy: StorageCheckout,
    candidate: { path: string; data: Buffer },
    opts?: StorageCommitOpts,
  ): Promise<StorageCommitResult>;
  /** Poll for changes (delta) where supported. */
  poll?(opts?: StoragePollOpts): Promise<StorageChange[]>;
}

export interface StorageCapabilities {
  versioning: boolean;
  conflictDetection: "etag" | "revisionId" | "refetch" | "none";
  permissions: boolean;
  deltaQueries: boolean;
  changeNotifications: boolean;
  uploadSessions: boolean;
  sharedDrives: boolean;
  /** Honest reduced-guarantee flag for synced local folders. */
  reducedGuarantee: boolean;
}

export interface StorageIdentity {
  /** Provider-specific stable id, or a path for local roots. */
  id: string;
  path?: string;
  webUrl?: string;
}

export interface StorageOpts {
  budget?: RequestBudget;
}

export interface StorageListOpts extends StorageOpts {
  pattern?: string;
}

export interface StorageCheckout {
  identity: StorageIdentity;
  version: string;
  etag?: string;
  revisionId?: string;
  data: Buffer;
  /** Where the working copy lives in the Quiver staging area. */
  workingCopyPath: string;
  permissions?: Record<string, unknown>;
}

export interface StorageMetadata {
  identity: StorageIdentity;
  name: string;
  mimeType: string;
  version: string;
  etag?: string;
  revisionId?: string;
  webUrl?: string;
  sizeBytes: number;
  modifiedAt: string;
  permissions?: Record<string, unknown>;
}

export interface StorageCommitOpts extends StorageOpts {
  /** The version/etag the change set was prepared against — fail on conflict. */
  baseVersion?: string;
  baseEtag?: string;
  reviewer: string;
  approvalRef: string;
}

export interface StorageCommitResult {
  identity: StorageIdentity;
  newVersion: string;
  etag?: string;
  revisionId?: string;
  webUrl?: string;
  committedAt: string;
}

export interface StorageChange {
  identity: StorageIdentity;
  kind: "created" | "modified" | "deleted";
  version: string;
  modifiedAt: string;
}

export interface StoragePollOpts extends StorageOpts {
  since?: string;
}

// ─── 5. ArtifactRepository (work-product plane) ──────────────────────

/**
 * Immutable source snapshots, staged working copies, evidence, diffs and
 * committed output identity (ADR-005). Never edits the original directly during
 * generation.
 */
export interface ArtifactRepository {
  /** Create an immutable source snapshot + isolated working copy. */
  stage(source: { identity: StorageIdentity; data: Buffer; mimeType: string; path?: string }, runId: string): Promise<StagedArtifact>;
  /** Record a candidate output against a staged working copy. */
  recordCandidate(staged: StagedArtifact, candidate: { path: string; data: Buffer; mimeType: string }): Promise<CandidateArtifact>;
  /** Attach the evidence companion for a candidate. */
  attachEvidence(candidate: CandidateArtifact, evidence: Record<string, unknown>): Promise<void>;
  /** Compute a semantic/visual diff between source and candidate. */
  diff(staged: StagedArtifact, candidate: CandidateArtifact): Promise<ArtifactDiff>;
  /** Mark approval state for a candidate (per-item, not only whole-run). */
  setApproval(candidate: CandidateArtifact, decision: ApprovalDecision): Promise<void>;
  /** Resolve the committed output identity after approval. */
  commit(candidate: CandidateArtifact): Promise<CommittedArtifact>;
  /** Rollback support — recover the previous committed artifact. */
  rollback(committed: CommittedArtifact): Promise<CommittedArtifact | null>;
}

export interface StagedArtifact {
  runId: string;
  sourceIdentity: StorageIdentity;
  sourceHash: string;
  sourceVersion: string;
  snapshotPath: string;
  workingCopyPath: string;
  createdAt: string;
}

export interface CandidateArtifact {
  staged: StagedArtifact;
  candidatePath: string;
  candidateHash: string;
  mimeType: string;
  evidenceRef?: string;
  approval: ApprovalState;
}

export interface ArtifactDiff {
  semantic: string;
  visual?: string;
  changes: Array<{ kind: "cell" | "paragraph" | "slide" | "figure"; locator: string; before?: string; after?: string }>;
}

export interface ApprovalDecision {
  reviewer: string;
  /** Accept/reject individual changes, cells, paragraphs or slides. */
  items: Array<{ locator: string; decision: "accepted" | "rejected"; comment?: string }>;
  overall: "accepted" | "rejected" | "partial";
}

export interface ApprovalState {
  status: "pending" | "in_review" | "accepted" | "rejected" | "partial";
  decisions: ApprovalDecision[];
}

export interface CommittedArtifact {
  candidate: CandidateArtifact;
  committedIdentity: StorageIdentity;
  committedVersion: string;
  committedAt: string;
  provenance: Record<string, unknown>;
  rollbackRef?: string;
}

// ─── 6. OfficeEngine (work-product plane) ─────────────────────────────

/**
 * OfficeCLI is the primary OfficeEngine (ADR-006): pinned, bundled,
 * checksum-verified, no background self-update. Not Microsoft Graph Excel APIs,
 * Office Scripts, VBA/COM, or an Office Add-in.
 */
export interface OfficeEngine {
  /** Structured read of an Office file (deterministic, not model-native). */
  read(path: string, opts?: OfficeReadOpts): Promise<OfficeStructure>;
  /** Edit a working copy (templates, deterministic merge, atomic batch). */
  edit(workingCopyPath: string, changes: OfficeChange[], opts?: OfficeEditOpts): Promise<OfficeEditResult>;
  validate(path: string, opts?: OfficeOpts): Promise<OfficeValidationResult>;
  /** Render–Look–Fix: render to image/PDF for visual inspection. */
  render(path: string, opts?: OfficeRenderOpts): Promise<OfficeRenderResult>;
  /** Semantic + visual comparison of two Office files. */
  compare(before: string, after: string, opts?: OfficeOpts): Promise<ArtifactDiff>;
  /** The pinned binary identity (version + checksum). */
  binaryIdentity(): { version: string; checksum: string; platform: string };
}

export interface OfficeReadOpts extends OfficeOpts {
  includeFormulas?: boolean;
  includeComments?: boolean;
}

export interface OfficeOpts {
  budget?: RequestBudget;
}

export interface OfficeEditOpts extends OfficeOpts {
  /** Atomic batch of changes. */
  atomic?: boolean;
}

export interface OfficeRenderOpts extends OfficeOpts {
  format: "png" | "pdf";
  pages?: number[];
}

export interface OfficeStructure {
  mimeType: string;
  sheets?: Array<{ name: string; formulas: Record<string, string>; values: Record<string, unknown> }>;
  paragraphs?: Array<{ id: string; text: string }>;
  slides?: Array<{ id: string; title?: string; body?: string }>;
  warnings: string[];
  /** High-risk flag for macro/encrypted/IRM/sensitivity-labelled files. */
  highRisk: boolean;
  riskReasons: string[];
}

export interface OfficeChange {
  kind: "cell" | "paragraph" | "slide" | "style" | "comment";
  locator: string;
  value: unknown;
}

export interface OfficeEditResult {
  path: string;
  applied: number;
  warnings: string[];
}

export interface OfficeValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface OfficeRenderResult {
  artifacts: Array<{ path: string; page: number }>;
}

// ─── 7. IntegrationBroker (knowledge plane) ──────────────────────────

/**
 * Retains direct APIs and MCPs (ADR-008). Each integration declares its
 * contract; MCP output and tool descriptions are untrusted input with preserved
 * provenance.
 */
export interface IntegrationBroker {
  list(): IntegrationDeclaration[];
  get(name: string): Integration | undefined;
  invoke(
    name: string,
    input: unknown,
    opts?: IntegrationInvokeOpts,
  ): Promise<IntegrationResult>;
  /** Policy decision: permitted only when all conditions resolve (§9). */
  decide(name: string, opts?: IntegrationInvokeOpts): PolicyDecisionResult;
}

export type EntitlementRight =
  | "internal-use"
  | "llm-processing"
  | "storage-caching"
  | "derived-data"
  | "redistribution"
  | "client-deliverable"
  | "training-prohibition";

export interface DataRights {
  /** What the run may do with this integration's data. Empty = no rights granted. */
  rights: EntitlementRight[];
  /** Max cache duration in hours (0 = no caching). */
  cacheDurationHours?: number;
  /** Retention/deletion: days before the data must be deleted. */
  retentionDays?: number;
  /** Geography/jurisdiction constraint (e.g. "US-only", "EU-only"). */
  geography?: string;
  /** Permitted users or teams (empty = all authenticated). */
  permittedUsers?: string[];
}

/** A policy condition that must be resolved BEFORE invocation is permitted. */
export interface PolicyCondition {
  /** Stable id, e.g. "entitlement-redistribution", "approval-human-signoff". */
  id: string;
  /** Human-readable reason the condition is unmet. */
  reason: string;
  /** Whether the condition has been resolved (true) or is still open (false). */
  resolved: boolean;
}

export interface IntegrationDeclaration {
  name: string;
  label: string;
  capabilities: string[];
  authScopes: string[];
  dataClassification: SensitivityProfile;
  readWrite: "read" | "write" | "read-write";
  requiredApprovals: string[];
  licensedDataRestrictions: string[];
  rateLimits?: { requestsPerMinute?: number };
  expectedCostUsd?: number;
  health: "healthy" | "degraded" | "unknown";
  freshness?: string;
  // §9 entitlements + operational limits.
  /** The rights matrix for data from this integration. */
  rights?: DataRights;
  /** Network zone required (loopback / private-network / public-internet). */
  networkZone?: "loopback" | "private-network" | "public-internet";
  /** Timeout (ms) and max output size (bytes) for the call. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Audit/redaction rules: fields to redact from logs/traces. */
  redactFields?: string[];
  /** Input/output JSON schema (for validation before/after). */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** A policy decision from the broker: permitted only when all conditions resolve. */
export interface PolicyDecisionResult {
  permitted: boolean;
  /** Unmet conditions — a non-empty list means NOT permitted (§9). */
  conditions: PolicyCondition[];
  reasons: string[];
}

export interface Integration {
  declaration: IntegrationDeclaration;
  invoke(input: unknown, opts?: IntegrationInvokeOpts): Promise<IntegrationResult>;
}

export interface IntegrationInvokeOpts {
  budget?: RequestBudget;
  sensitivity?: SensitivityProfile;
  approvals?: string[];
  /** Resolved conditions (ids that the caller has satisfied). */
  resolvedConditions?: string[];
  /** The execution context (entitlements, zone, actor). */
  executionContext?: import("../security/execution_context.js").ExecutionContext;
}

export interface IntegrationResult {
  ok: boolean;
  data?: unknown;
  provenance: { vendor: string; dataset: string; apiRef: string; timestamp: string; url?: string };
  warnings?: string[];
  error?: string;
}

// ─── 8. PromptCompiler (control/knowledge planes) ────────────────────

/**
 * Versioned prompt compilation from explicit layers (ADR-004). Replaces
 * scattered, customer-insensitive system prompts.
 */
export interface PromptCompiler {
  compile(input: PromptCompileInput): CompiledPrompt;
  /** The customer pack currently bound (data, not a code fork). */
  pack(): CustomerPackRef;
}

export interface PromptCompileInput {
  role: "planner" | "maker" | "checker" | "reviewer";
  goal?: { objective: string; definitionOfDone: string[] };
  approvedContext?: string;
  gapLedger?: GapEntry[];
  runState?: Record<string, unknown>;
  workflowSpecId?: string;
}

export interface CompiledPrompt {
  version: string;
  systemPrompt: string;
  layers: Array<{ name: string; included: boolean; tokenEstimate: number }>;
  totalTokenEstimate: number;
}

export interface CustomerPackRef {
  id: string;
  version: string;
  /** A redacted summary safe to log (never includes secrets). */
  summary: string;
}

// ─── 9. PolicyEngine (control plane) ─────────────────────────────────

/**
 * Enforces sensitivity, source-category, entitlement, approval and budget
 * policy. Fails closed. High-sensitivity content never falls back to OpenRouter
 * (ADR-001/ADR-003).
 */
export interface PolicyEngine {
  /** Classify a request's sensitivity profile. */
  classify(input: PolicyClassificationInput): SensitivityProfile;
  /** Decide whether a model/research/storage action is permitted. */
  decide(request: PolicyRequest): PolicyDecision;
  /** Resolve required source categories to concrete approved connectors. */
  resolveSourceCategories(
    required: SourceCategory[],
    available: IntegrationDeclaration[],
  ): SourceCategoryResolution;
}

export type SensitivityProfile = "public" | "confidential-internal" | "restricted-mnpi";

export interface PolicyClassificationInput {
  contentHint?: string;
  customerPackId?: string;
  workflowSpecId?: string;
  declaredProfile?: SensitivityProfile;
}

export interface PolicyRequest {
  kind: "model" | "research" | "storage" | "integration" | "office" | "memory";
  sensitivity: SensitivityProfile;
  route?: string;
  dataCategories?: SourceCategory[];
  budget?: { costUsd?: number; timeMs?: number };
}

export interface PolicyDecision {
  permitted: boolean;
  /** The enforced route (e.g. "local" for restricted-mnpi). */
  enforcedRoute?: string;
  reasons: string[];
  /** Conditions the caller must satisfy (e.g. "redact internal thesis before Parallel"). */
  conditions?: string[];
}

export interface SourceCategoryResolution {
  resolved: Array<{ category: SourceCategory; connector: string }>;
  missing: SourceCategory[];
  /** Substitution requires explicit warning + approval. */
  substitutionWarnings: string[];
}

// ─── 10. TraceSink (all planes) ──────────────────────────────────────

/**
 * Local/customer-controlled OpenTelemetry by default (ADR-010). Never sends
 * prompts, documents, source excerpts or tool results to a SaaS. LangSmith is
 * an explicit, redacted customer option only.
 */
export interface TraceSink {
  startSpan(name: string, attrs?: Record<string, unknown>): TraceSpan;
  /** Emit a structured event (metadata only — no prompt/document content). */
  event(span: TraceSpan, name: string, attrs?: Record<string, unknown>): void;
  endSpan(span: TraceSpan, attrs?: Record<string, unknown>): void;
  /** Whether content-bearing payloads are redacted at this sink. */
  readonly redactsContent: boolean;
}

export interface TraceSpan {
  spanId: string;
  name: string;
  attrs: Record<string, unknown>;
}

// ─── Shared domain enums ─────────────────────────────────────────────

/**
 * Capital-markets source categories (ADR-007). No substitution without an
 * explicit warning and approval.
 */
export type SourceCategory =
  | "market-data-estimates"
  | "filings-ir"
  | "transcripts-events"
  | "portfolio-models-trackers"
  | "internal-research-notes"
  | "public-web-research";

export const ALL_SOURCE_CATEGORIES: readonly SourceCategory[] = [
  "market-data-estimates",
  "filings-ir",
  "transcripts-events",
  "portfolio-models-trackers",
  "internal-research-notes",
  "public-web-research",
] as const;