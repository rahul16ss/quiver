/**
 * Shared helpers and types for the investment-committee-memo demo.
 *
 * Illustrative workflow — synthetic data. Self-contained: nothing here is
 * imported by src/; the demo only shells out to the `officecli` binary.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to examples/investment-committee-memo/. */
export const EXAMPLE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The honesty label every artifact must carry. */
export const LABEL = "Illustrative workflow — synthetic data";
export const FOOTER_TEXT = `${LABEL} · Draft for review`;

/** Resolve a path relative to the example directory. */
export function p(...parts: string[]): string {
  return path.join(EXAMPLE_DIR, ...parts);
}

/** Relative (example-dir-rooted, forward-slash) form for use inside artifacts. */
export function rel(abs: string): string {
  return path.relative(EXAMPLE_DIR, abs).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// officecli
// ---------------------------------------------------------------------------

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run officecli with an argument array (no shell — paths with & or spaces are safe). */
export function officecli(args: string[], opts: { allowFail?: boolean } = {}): CliResult {
  const res = spawnSync("officecli", args, { encoding: "utf8", cwd: EXAMPLE_DIR });
  if (res.error) throw new Error(`failed to spawn officecli: ${res.error.message}`);
  const out: CliResult = { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (out.status !== 0 && !opts.allowFail) {
    throw new Error(
      `officecli ${args.join(" ")} exited ${out.status}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`,
    );
  }
  return out;
}

/** Run officecli with --json and return the parsed `data` payload. */
export function officecliJson<T = unknown>(args: string[]): T {
  const res = officecli([...args, "--json"]);
  const parsed = JSON.parse(res.stdout) as { success: boolean; data: T; error?: unknown };
  if (!parsed.success) {
    throw new Error(`officecli ${args.join(" ")} returned success=false: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.data;
}

interface QueryResults {
  matches: number;
  results: Array<{
    path: string;
    type: string;
    text?: string;
    style?: string;
    format?: Record<string, unknown>;
  }>;
}

/** Read a single cell's displayed text (computed value for formula cells). */
export function getCellText(file: string, sheet: string, cell: string): string {
  const data = officecliJson<QueryResults>(["get", file, `/${sheet}/${cell}`]);
  if (data.matches !== 1) throw new Error(`expected 1 match for /${sheet}/${cell}, got ${data.matches}`);
  return data.results[0].text ?? "";
}

/** Query docx elements (paragraphs, cells, ...) as JSON. */
export function queryDoc(file: string, selector: string): QueryResults {
  return officecliJson<QueryResults>(["query", file, selector]);
}

export function officecliVersion(): string {
  return officecli(["--version"]).stdout.trim();
}

// ---------------------------------------------------------------------------
// Fixtures: types + loading
// ---------------------------------------------------------------------------

export type Relationship = "sourced" | "derived" | "estimate" | "unresolved";
export type ReviewStatus = "verified" | "needs_analyst" | "flagged" | "unresolved";

export interface SourceRecord {
  source_id: string;
  source_type: "excel_model" | "filing" | "transcript" | "internal_note" | "vendor_export" | "web" | "template";
  title: string;
  file: string;
  as_of: string;
  location: { sheet?: string; cell?: string; section?: string; page?: number; description?: string };
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

export interface ClaimRecord {
  claim_id: string;
  rendered_text: string;
  source_ids: string[];
  relationship: Relationship;
  review_status: ReviewStatus;
  reviewer_decision: null | string;
  is_quantitative: boolean;
  review_note?: string;
  verification?: ExcelCellVerification | ExcelDerivedVerification;
  table?: { metric: string; value: string; source: string; status: string };
}

export interface MemoSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  table_claim_ids?: string[];
}

export interface MemoContent {
  label: string;
  workflow: string;
  workflow_version: string;
  company: string;
  as_of: string;
  title: string;
  subtitle: string;
  date_line: string;
  claims: ClaimRecord[];
  sections: MemoSection[];
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function loadSources(): SourceRegistry {
  return readJson<SourceRegistry>(p("fixtures", "sources.json"));
}

export function loadMemoContent(): MemoContent {
  return readJson<MemoContent>(p("fixtures", "memo-content.json"));
}

// ---------------------------------------------------------------------------
// Acceptance checklist (minimal YAML subset parser — enough for our file)
// ---------------------------------------------------------------------------

export interface ChecklistEntry {
  id: string;
  name: string;
  description: string;
}

/**
 * Parse acceptance-checklist.yaml. Deliberately minimal: understands the
 * `checks:` list with `id` / `name` / `description` (plain or `>` folded)
 * scalars used in this example — not a general YAML parser.
 */
export function loadChecklist(): ChecklistEntry[] {
  const text = fs.readFileSync(p("acceptance-checklist.yaml"), "utf8");
  const entries: ChecklistEntry[] = [];
  let current: Partial<ChecklistEntry> | null = null;
  let foldingKey: "description" | null = null;
  let folded: string[] = [];
  const flushFold = () => {
    if (current && foldingKey) current[foldingKey] = folded.join(" ").trim();
    foldingKey = null;
    folded = [];
  };
  const flushEntry = () => {
    flushFold();
    if (current?.id && current.name) {
      entries.push({ id: current.id, name: current.name, description: current.description ?? "" });
    }
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const itemStart = raw.match(/^\s*-\s+id:\s*(.+)$/);
    if (itemStart) {
      flushEntry();
      current = { id: itemStart[1].trim() };
      continue;
    }
    if (!current) continue;
    if (foldingKey) {
      if (/^\s{6,}\S/.test(raw)) {
        folded.push(raw.trim());
        continue;
      }
      flushFold();
    }
    const kv = raw.match(/^\s{4}(name|description):\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (value.trim() === ">" || value.trim() === "|") {
        if (key === "description") foldingKey = "description";
      } else if (key === "name") {
        current.name = value.trim();
      } else {
        current.description = value.trim();
      }
    }
  }
  flushEntry();
  return entries;
}

/** Read `name:` and `version:` from workflow.yaml. */
export function loadWorkflowMeta(): { name: string; version: string } {
  const text = fs.readFileSync(p("workflow.yaml"), "utf8");
  const name = text.match(/^name:\s*(\S+)/m)?.[1];
  const version = text.match(/^version:\s*(\S+)/m)?.[1];
  if (!name || !version) throw new Error("workflow.yaml must define name: and version:");
  return { name, version };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export const INPUT_FILES = [
  "inputs/Model_v12.xlsx",
  "inputs/10q-excerpt.md",
  "inputs/earnings-call-q2-transcript.md",
  "inputs/internal-model-note.md",
  "inputs/comps.csv",
];

export const OUTPUT = {
  dir: "output",
  docx: "output/Project_Alder_IC_Memo.docx",
  evidenceJson: "output/Project_Alder_Evidence.json",
  evidenceHtml: "output/Project_Alder_Evidence.html",
  reviewChecklist: "output/Project_Alder_Review_Checklist.md",
  runRecord: "output/Project_Alder_Run_Record.json",
} as const;

export const REQUIRED_SECTIONS = [
  "Executive summary",
  "Financial overview",
  "Key investment considerations",
  "Principal risks",
  "Open diligence items",
  "Review checklist reference",
];
