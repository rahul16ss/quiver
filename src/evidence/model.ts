/**
* Evidence Model — the type system for source-backed document lineage.
*
* This is the live-drafting counterpart to the flagship example's
* fixtures/sources.json and fixtures/memo-content.json. When the agent
* drafts an Office document, it registers sources and records claims
* through the evidence tool; the tracker writes Evidence.json alongside
* the document so the GUI can render lineage chips and the checker can
* reject unsourced figures.
*
* Schema is intentionally compatible with the flagship example so the
* same GUI rendering and acceptance-check logic works for both.
*/

// ─── Source Types ─────────────────────────────────────────────────────

export type SourceType =
| "excel_model"
| "filing"
| "transcript"
| "internal_note"
| "vendor_export"
| "web"
| "template"
| "research_report"
| "news"
| "other";

export interface SourceLocation {
  sheet?: string;
  cell?: string;
  section?: string;
  page?: number;
  url?: string;
  description?: string;
}

export interface SourceRecord {
  source_id: string;
  source_type: SourceType;
  title: string;
  file: string;
  as_of: string;
  location: SourceLocation;
  sensitivity: string;
  approved: boolean;
  extracted_value?: string;
  excerpt?: string;
  exclusion_reason?: string;
}

export interface SourceRegistry {
  label: string;
  registry_version: string;
  as_of: string;
  sources: SourceRecord[];
}

// ─── Claim Types ──────────────────────────────────────────────────────

export type Relationship = "sourced" | "derived" | "estimate" | "unresolved";
export type ReviewStatus = "verified" | "needs_analyst" | "flagged" | "unresolved";

export interface ExcelCellVerification {
  type: "excel_cell";
  file: string;
  sheet: string;
  cell: string;
  expected_raw: number;
  rendered_value: string;
}

export interface ExcelDerivedVerification {
  type: "excel_derived";
  file: string;
  numerator: { sheet: string; cell: string; expected_raw: number };
  denominator: { sheet: string; cell: string; expected_raw: number };
  derivation: string;
  expected_ratio_pct: string;
  rendered_value: string;
}

export type Verification = ExcelCellVerification | ExcelDerivedVerification;

export interface ClaimTableEntry {
  metric: string;
  value: string;
  source: string;
  status: string;
}

export interface ClaimRecord {
  claim_id: string;
  rendered_text: string;
  source_ids: string[];
  relationship: Relationship;
  review_status: ReviewStatus;
  reviewer_decision: null | string;
  is_quantitative: boolean;
  review_note?: string;
  verification?: Verification;
  table?: ClaimTableEntry;
}

// ─── Evidence Model (the full artifact) ──────────────────────────────

export interface EvidenceModel {
  label: string;
  workflow: string;
  workflow_version: string;
  company: string;
  as_of: string;
  title: string;
  subtitle: string;
  date_line: string;
  claims: ClaimRecord[];
  sources: SourceRecord[];
  sources_excluded: Array<{ source_id: string; reason: string }>;
  review_status: "draft_for_review";
  generated_at: string;
  generated_by: "live_agent";
}

// ─── Run Record ──────────────────────────────────────────────────────

export interface RunRecordInput {
  file: string;
  sha256: string;
}

export interface RunRecord {
  workflow: string;
  workflow_version: string;
  review_status: "draft_for_review";
  generated_at: string;
  inputs: RunRecordInput[];
  sources_excluded: Array<{ source_id: string; reason: string }>;
  acceptance_checks?: Array<{ id: string; pass: boolean; detail: string }>;
}
