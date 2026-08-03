/**
 * Workflow Engine — shared types.
 *
 * Every module in `src/workflow/` imports from here. The types model
 * the full lifecycle promised by Conviction Studio: discover → map →
 * build → verify → train → handover.
 *
 * SPEC §4.1 / §12 / §19 Build Order #7.
 */

// ─── Workflow Definition (parsed from workflow.yaml) ──────────────────

export type WorkflowFamily = "dealmaking" | "research" | "wealth";

export type WorkflowPhase =
  | "discover"
  | "map"
  | "build"
  | "verify"
  | "train"
  | "handover";

export const PHASE_ORDER: readonly WorkflowPhase[] = [
  "discover",
  "map",
  "build",
  "verify",
  "train",
  "handover",
] as const;

export interface WorkflowDefinition {
  /** Workflow name (e.g. "investment-committee-memo") */
  name: string;
  /** Family: dealmaking, research, wealth */
  family: WorkflowFamily;
  /** Semantic version */
  version: string;
  /** Maturity stage */
  maturity: "demo-ready" | "beta" | "production";
  /** Purpose description */
  business_purpose: string;
  /** Path to the output template (relative to pack root) */
  output_template?: string;
  /** Allowed input file paths (relative to pack root) */
  allowed_inputs: string[];
  /** Retrieval mode */
  retrieval?: { mode: "static" | "dynamic"; network_access: "none" | "public" | "authenticated" };
  /** Data sensitivity level */
  data_sensitivity: "synthetic" | "public" | "internal" | "confidential" | "mnpi";
  /** Expected deliverable sections */
  deliverable_sections: string[];
  /** Review role description */
  review_role?: string;
  /** Path to acceptance checklist (relative to pack root) */
  acceptance_checks?: string;
  /** Output directory and file specs */
  outputs?: Record<string, string>;
  /** Schedule spec for recurring runs */
  schedule?: ScheduleSpec;
  /** Watch spec for file-triggered runs */
  watch?: WatchSpec;
  /** The absolute path to the pack root directory */
  packRoot: string;
}

// ─── Schedule & Watch ────────────────────────────────────────────────

export interface ScheduleSpec {
  /** Standard 5-field cron expression */
  cron: string;
  /** Human-readable label */
  label?: string;
  /** Parameters passed to the workflow */
  params?: Record<string, unknown>;
}

export interface WatchSpec {
  /** Directories to watch (absolute or relative to cwd) */
  directories: string[];
  /** File glob patterns to match (e.g., "*.pdf", "*.xlsx") */
  patterns: string[];
  /** Debounce interval in milliseconds */
  debounce_ms?: number;
}

// ─── Workflow Run State ──────────────────────────────────────────────

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface PhaseResult {
  phase: WorkflowPhase;
  status: "completed" | "failed" | "skipped";
  started_at: string;
  completed_at: string;
  /** Free-form output from the phase */
  output?: string;
  /** Errors encountered */
  errors?: string[];
  /** Files produced in this phase */
  artifacts?: string[];
}

export interface WorkflowRun {
  /** Unique run ID (e.g., "WF-2026-0803-001") */
  run_id: string;
  /** Workflow name */
  workflow: string;
  /** Workflow family */
  family: WorkflowFamily;
  /** Overall status */
  status: RunStatus;
  /** Current phase */
  current_phase: WorkflowPhase | null;
  /** Phase results (accumulated) */
  phases: PhaseResult[];
  /** When the run started */
  started_at: string;
  /** When the run completed (null if still running) */
  completed_at: string | null;
  /** Input files used */
  inputs: string[];
  /** Deliverable files produced */
  deliverables: string[];
  /** Trigger source */
  trigger: "manual" | "schedule" | "watch" | "api";
  /** Error message if failed */
  error?: string;
}

// ─── Multi-Role Review ───────────────────────────────────────────────

export type ReviewRole = "analyst" | "senior_analyst" | "vp" | "principal" | "partner" | "ic_member" | "pm" | "cio" | "advisor" | "custom";

export interface ReviewDecision {
  role: ReviewRole;
  reviewer: string;
  decision: "approved" | "rejected" | "commented";
  comment?: string;
  timestamp: string;
}

export interface DocumentReview {
  /** Document path */
  document: string;
  /** Workflow run ID */
  run_id: string;
  /** Current review stage */
  stage: ReviewRole;
  /** Required reviewers in order */
  required_reviewers: ReviewRole[];
  /** Decisions made so far */
  decisions: ReviewDecision[];
  /** Overall status */
  status: "pending" | "in_review" | "approved" | "rejected";
  /** Created timestamp */
  created_at: string;
  /** Last updated timestamp */
  updated_at: string;
}

// ─── Handover Package ────────────────────────────────────────────────

export interface HandoverPackage {
  /** Workflow name */
  workflow: string;
  /** Run ID that produced this handover */
  run_id: string;
  /** Generated runbook (Markdown content) */
  runbook: string;
  /** Acceptance check results */
  acceptance_results: Array<{ id: string; pass: boolean; detail: string }>;
  /** Input files used */
  inputs_used: string[];
  /** Deliverables produced */
  deliverables: string[];
  /** Maintenance instructions */
  maintenance_notes: string;
  /** Generated timestamp */
  generated_at: string;
}

// ─── Event System (for daemon SSE integration) ───────────────────────

export type WorkflowEventType =
  | "workflow:started"
  | "workflow:phase_started"
  | "workflow:phase_completed"
  | "workflow:completed"
  | "workflow:failed"
  | "workflow:paused"
  | "review:submitted"
  | "review:decided"
  | "schedule:triggered"
  | "watch:file_detected";

export interface WorkflowEvent {
  type: WorkflowEventType;
  run_id: string;
  workflow: string;
  timestamp: string;
  data: Record<string, unknown>;
}
