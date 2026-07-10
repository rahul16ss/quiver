/**
 * Acceptance checks for the investment-committee-memo demo.
 *
 * One implementation per id in acceptance-checklist.yaml. Every check reads
 * the generated artifacts (or the source workbook) back through officecli or
 * the filesystem — none of them trust the writer's own bookkeeping.
 *
 * Illustrative workflow — synthetic data.
 */
import * as fs from "node:fs";
import {
  ClaimRecord,
  ExcelCellVerification,
  ExcelDerivedVerification,
  INPUT_FILES,
  MemoContent,
  OUTPUT,
  REQUIRED_SECTIONS,
  SourceRegistry,
  getCellText,
  officecli,
  p,
  queryDoc,
  readJson,
  sha256,
} from "./lib.ts";

export interface CheckResult {
  id: string;
  pass: boolean;
  detail: string;
}

export interface CheckContext {
  memo: MemoContent;
  registry: SourceRegistry;
}

type CheckFn = (ctx: CheckContext) => CheckResult;

// --- helpers ---------------------------------------------------------------

function docxBodyHeadings(): string[] {
  const q = queryDoc(p(OUTPUT.docx), "paragraph");
  return q.results
    .filter((r) => r.path.startsWith("/body/") && (r.format?.styleId ?? r.style) === "Heading1")
    .map((r) => r.text ?? "");
}

interface DocxTableRow {
  metric: string;
  value: string;
}

/** Read the financial-overview table back out of the generated docx. */
function docxTableRows(): DocxTableRow[] {
  const q = queryDoc(p(OUTPUT.docx), "cell");
  const grid = new Map<number, Map<number, string>>();
  for (const r of q.results) {
    const m = r.path.match(/^\/body\/tbl\[1\]\/tr\[(\d+)\]\/tc\[(\d+)\]$/);
    if (!m) continue;
    const row = Number(m[1]);
    if (!grid.has(row)) grid.set(row, new Map());
    grid.get(row)!.set(Number(m[2]), r.text ?? "");
  }
  const rows: DocxTableRow[] = [];
  for (const rowIdx of [...grid.keys()].sort((a, b) => a - b)) {
    if (rowIdx === 1) continue; // header row
    const cells = grid.get(rowIdx)!;
    rows.push({ metric: cells.get(1) ?? "", value: cells.get(2) ?? "" });
  }
  return rows;
}

// --- checks ----------------------------------------------------------------

const sectionsPresent: CheckFn = () => {
  const found = docxBodyHeadings();
  const pass =
    found.length === REQUIRED_SECTIONS.length && REQUIRED_SECTIONS.every((s, i) => found[i] === s);
  return {
    id: "sections-present",
    pass,
    detail: pass
      ? `all ${REQUIRED_SECTIONS.length} sections present in order (read back via officecli query)`
      : `expected [${REQUIRED_SECTIONS.join("; ")}], found [${found.join("; ")}]`,
  };
};

const docxValidates: CheckFn = () => {
  const res = officecli(["validate", p(OUTPUT.docx)], { allowFail: true });
  const pass = res.status === 0 && /Validation passed/i.test(res.stdout);
  return {
    id: "docx-validates",
    pass,
    detail: pass ? "officecli validate: no errors" : `validate output: ${res.stdout} ${res.stderr}`.trim(),
  };
};

const noPlaceholderText: CheckFn = () => {
  const texts: string[] = [];
  for (const selector of ["paragraph", "cell"]) {
    for (const r of queryDoc(p(OUTPUT.docx), selector).results) {
      if (r.text) texts.push(r.text);
    }
  }
  const patterns: Array<[string, RegExp]> = [
    ["{{...}} merge field", /\{\{|\}\}/],
    ["TODO marker", /\bTODO\b/i],
    ["TBD marker", /\bTBD\b/i],
    ["lorem ipsum", /lorem/i],
    ["placeholder marker", /\bplaceholder\b/i],
  ];
  const hits: string[] = [];
  for (const t of texts) {
    for (const [label, re] of patterns) {
      if (re.test(t)) hits.push(`${label} in "${t.slice(0, 60)}"`);
    }
  }
  return {
    id: "no-placeholder-text",
    pass: hits.length === 0,
    detail: hits.length === 0 ? `scanned ${texts.length} text elements (paragraphs, table cells, footer)` : hits.join("; "),
  };
};

const claimsHaveSources: CheckFn = ({ memo, registry }) => {
  const approved = new Set(registry.sources.filter((s) => s.approved).map((s) => s.source_id));
  const excluded = new Set(registry.sources.filter((s) => !s.approved).map((s) => s.source_id));
  const problems: string[] = [];
  for (const c of memo.claims) {
    if (c.source_ids.some((id) => excluded.has(id))) {
      problems.push(`${c.claim_id} cites an excluded source`);
    }
    if (!c.is_quantitative) continue;
    const sourced = c.source_ids.some((id) => approved.has(id));
    const flagged = c.review_status === "flagged" || c.review_status === "unresolved";
    if (!sourced && !flagged) problems.push(`${c.claim_id} has no approved source and is not flagged/unresolved`);
  }
  return {
    id: "claims-have-sources",
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${memo.claims.filter((c) => c.is_quantitative).length} quantitative claims all sourced or flagged; none cite excluded sources`
        : problems.join("; "),
  };
};

/** Millions formatting used by the memo, e.g. 48200000 -> "$48.2 million". */
function asMillions(raw: number): string {
  return `$${(raw / 1_000_000).toFixed(1)} million`;
}

const excelCellVerification: CheckFn = ({ memo }) => {
  const details: string[] = [];
  const problems: string[] = [];
  for (const c of memo.claims) {
    const v = c.verification;
    if (!v) continue;
    if (v.type === "excel_cell") {
      const vv = v as ExcelCellVerification;
      const actual = getCellText(p(vv.file), vv.sheet, vv.cell);
      const cmd = `officecli get ${vv.file} "/${vv.sheet}/${vv.cell}" --json`;
      if (Number(actual) !== vv.expected_raw) {
        problems.push(`${c.claim_id}: ${vv.sheet}!${vv.cell} = ${actual}, claim expects ${vv.expected_raw} (${cmd})`);
        continue;
      }
      if (asMillions(Number(actual)) !== vv.rendered_value) {
        problems.push(`${c.claim_id}: cell value ${actual} renders as "${asMillions(Number(actual))}" but memo says "${vv.rendered_value}"`);
        continue;
      }
      details.push(`${c.claim_id}: ${vv.sheet}!${vv.cell} read as ${actual} -> "${vv.rendered_value}" (${cmd})`);
    } else if (v.type === "excel_derived") {
      const vd = v as ExcelDerivedVerification;
      const num = Number(getCellText(p(vd.file), vd.numerator.sheet, vd.numerator.cell));
      const den = Number(getCellText(p(vd.file), vd.denominator.sheet, vd.denominator.cell));
      const cmds = `officecli get ${vd.file} "/${vd.numerator.sheet}/${vd.numerator.cell}" --json; officecli get ${vd.file} "/${vd.denominator.sheet}/${vd.denominator.cell}" --json`;
      if (num !== vd.numerator.expected_raw || den !== vd.denominator.expected_raw) {
        problems.push(`${c.claim_id}: cells read (${num}, ${den}), claim expects (${vd.numerator.expected_raw}, ${vd.denominator.expected_raw})`);
        continue;
      }
      const pct = ((num / den) * 100).toFixed(1);
      if (pct !== vd.expected_ratio_pct || !vd.rendered_value.startsWith(pct)) {
        problems.push(`${c.claim_id}: recomputed ${pct}% does not match rendered "${vd.rendered_value}"`);
        continue;
      }
      details.push(`${c.claim_id}: ${vd.numerator.sheet}!${vd.numerator.cell}=${num} / ${vd.denominator.sheet}!${vd.denominator.cell}=${den} -> ${pct}% (${cmds})`);
    }
  }
  if (details.length === 0) problems.push("no Excel-verified claims found — the key trust feature would be vacuous");
  return {
    id: "excel-cell-verification",
    pass: problems.length === 0,
    detail: problems.length === 0 ? details.join(" | ") : problems.join("; "),
  };
};

const tableMatchesEvidence: CheckFn = () => {
  const evidence = readJson<{ claims: ClaimRecord[] }>(p(OUTPUT.evidenceJson));
  const evidenceRows = evidence.claims
    .filter((c) => c.table)
    .map((c) => `${c.table!.metric} = ${c.table!.value}`);
  const docxRows = docxTableRows().map((r) => `${r.metric} = ${r.value}`);
  const missingInDocx = evidenceRows.filter((r) => !docxRows.includes(r));
  const missingInEvidence = docxRows.filter((r) => !evidenceRows.includes(r));
  const pass = missingInDocx.length === 0 && missingInEvidence.length === 0 && docxRows.length > 0;
  return {
    id: "table-matches-evidence",
    pass,
    detail: pass
      ? `${docxRows.length} table rows match the evidence map bidirectionally`
      : `missing in docx: [${missingInDocx.join("; ")}]; missing in evidence: [${missingInEvidence.join("; ")}]`,
  };
};

const unresolvedInChecklist: CheckFn = ({ memo }) => {
  const md = fs.readFileSync(p(OUTPUT.reviewChecklist), "utf8");
  const unresolved = memo.claims.filter((c) => c.review_status === "unresolved");
  const missing = unresolved.filter((c) => !md.includes(c.claim_id));
  const pass = missing.length === 0 && unresolved.length > 0 && /unresolved/i.test(md);
  return {
    id: "unresolved-in-checklist",
    pass,
    detail: pass
      ? `${unresolved.length} unresolved claim(s) (${unresolved.map((c) => c.claim_id).join(", ")}) present in the review checklist`
      : `unresolved claims missing from checklist: ${missing.map((c) => c.claim_id).join(", ") || "(none unresolved in fixtures — vacuous)"}`,
  };
};

interface RunRecord {
  review_status: string;
  inputs: Array<{ file: string; sha256: string }>;
  sources_excluded: Array<{ source_id: string; reason: string }>;
}

const runRecordComplete: CheckFn = ({ registry }) => {
  const rec = readJson<RunRecord>(p(OUTPUT.runRecord));
  const problems: string[] = [];
  for (const f of INPUT_FILES) {
    const entry = rec.inputs.find((i) => i.file === f);
    if (!entry) {
      problems.push(`input ${f} missing from run record`);
      continue;
    }
    const actual = sha256(p(f));
    if (entry.sha256 !== actual) problems.push(`hash mismatch for ${f}`);
  }
  const excluded = registry.sources.filter((s) => !s.approved);
  for (const s of excluded) {
    const entry = rec.sources_excluded.find((e) => e.source_id === s.source_id);
    if (!entry) problems.push(`excluded source ${s.source_id} missing from run record`);
    else if (!entry.reason) problems.push(`excluded source ${s.source_id} has no reason`);
  }
  if (excluded.length === 0) problems.push("registry has no excluded source — exclusion handling untested");
  if (rec.review_status !== "draft_for_review") problems.push(`review_status is "${rec.review_status}"`);
  return {
    id: "run-record-complete",
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${INPUT_FILES.length} inputs re-hashed and matched; ${excluded.length} excluded source recorded with reason; status draft_for_review`
        : problems.join("; "),
  };
};

export const CHECK_IMPLEMENTATIONS: Record<string, CheckFn> = {
  "sections-present": sectionsPresent,
  "docx-validates": docxValidates,
  "no-placeholder-text": noPlaceholderText,
  "claims-have-sources": claimsHaveSources,
  "excel-cell-verification": excelCellVerification,
  "table-matches-evidence": tableMatchesEvidence,
  "unresolved-in-checklist": unresolvedInChecklist,
  "run-record-complete": runRecordComplete,
};
