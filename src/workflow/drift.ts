/**
 * Drift detection — SPEC §12.4.
 *
 * The workflow artifact records the expected source structure (sheet/tab names,
 * key cell anchors + their expected raw values, filing sections). On run, if a
 * source has drifted since the workflow was authored, the harness halts and
 * surfaces the specific mismatch rather than producing a draft with broken
 * lineage. This is the "don't silently produce a wrong memo" guard.
 *
 * Expected structure is a JSON file (`expected-structure.json` next to the
 * workflow) so no YAML parser is required. officecli reads the live cells.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { findBinary } from "../utils/find_binary.js";

export interface ExpectedCell {
  sheet: string;
  cell: string;
  /** Expected raw numeric value (the committed fixture value). */
  expected_raw?: number;
  /** Expected displayed text, if easier to assert than the raw number. */
  expected_text?: string;
}
export interface ExpectedSheet {
  name: string;
  /** Key cells to verify. If empty, only the sheet's existence is checked. */
  cells?: ExpectedCell[];
}
export interface ExpectedFiling {
  file: string;
  /** Section headings that must be present. */
  sections?: string[];
}
export interface ExpectedStructure {
  excel_model?: { file: string; sheets: ExpectedSheet[] };
  filings?: ExpectedFiling[];
}
export interface DriftMismatch {
  source: string;
  expected: string;
  actual: string;
  reason: string;
}
export interface DriftResult {
  drifted: boolean;
  mismatches: DriftMismatch[];
  summary: string;
}

function officecli(args: string[]): string {
  const bin = findBinary("officecli");
  if (!bin) throw new Error("officecli binary not found");
  return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

function officecliJson(args: string[]): any {
  // officecli --json wraps the payload as { data: ... } (see examples/.../lib.ts).
  const out = officecli([...args, "--json"]);
  try { return JSON.parse(out).data; } catch { return JSON.parse(out); }
}

/** Load expected-structure.json (returns null if absent — drift check skipped). */
export function loadExpectedStructure(dir: string): ExpectedStructure | null {
  const p = path.join(dir, "expected-structure.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Check the live sources against the expected structure. Returns mismatches;
 * `drifted` is true if any. Halts-before-draft callers check `drifted`.
 */
export function checkDrift(expected: ExpectedStructure, sourcesDir: string): DriftResult {
  const mismatches: DriftMismatch[] = [];
  const excel = expected.excel_model;
  if (excel) {
    const file = path.join(sourcesDir, path.basename(excel.file));
    for (const sheet of excel.sheets) {
      // Sheet existence: query the workbook for the sheet.
      let sheetExists = false;
      try {
        const data = officecliJson(["get", file, `/${sheet.name}`]);
        sheetExists = !!data && (data.matches === undefined || data.matches >= 1 || data.path || data.results);
      } catch {
        sheetExists = false;
      }
      if (!sheetExists) {
        mismatches.push({ source: `${excel.file}/${sheet.name}`, expected: "sheet present", actual: "missing", reason: "sheet/tab not found — the model structure changed" });
        continue;
      }
      for (const c of sheet.cells || []) {
        try {
          const data = officecliJson(["get", file, `/${sheet.name}/${c.cell}`]);
          const text = data?.results?.[0]?.text ?? "";
          if (c.expected_text !== undefined && text !== c.expected_text) {
            mismatches.push({ source: `${excel.file}/${sheet.name}!${c.cell}`, expected: c.expected_text, actual: text, reason: "cell value changed since the workflow was authored" });
          } else if (c.expected_raw !== undefined) {
            const num = Number(String(text).replace(/[^0-9.\-]/g, ""));
            if (!Number.isFinite(num) || Math.abs(num - c.expected_raw) > 1e-6) {
              mismatches.push({ source: `${excel.file}/${sheet.name}!${c.cell}`, expected: String(c.expected_raw), actual: text, reason: "cell numeric value drifted" });
            }
          }
        } catch (e: any) {
          mismatches.push({ source: `${excel.file}/${sheet.name}!${c.cell}`, expected: "cell present", actual: "read error", reason: e?.message || String(e) });
        }
      }
    }
  }
  for (const f of expected.filings || []) {
    const file = path.join(sourcesDir, path.basename(f.file));
    if (!fs.existsSync(file)) {
      mismatches.push({ source: f.file, expected: "file present", actual: "missing", reason: "filing input not found" });
      continue;
    }
    if (f.sections && f.sections.length) {
      const text = fs.readFileSync(file, "utf8");
      for (const sec of f.sections) {
        if (!text.includes(sec)) {
          mismatches.push({ source: f.file, expected: `section "${sec}"`, actual: "absent", reason: "expected section not found — the filing structure changed" });
        }
      }
    }
  }
  const drifted = mismatches.length > 0;
  const summary = drifted
    ? `${mismatches.length} drift mismatch(es): ${mismatches.map((m) => m.source).join(", ")}`
    : "no drift detected — sources match the expected structure";
  return { drifted, mismatches, summary };
}