/**
 * Investment-committee-memo demo pipeline. Run from the repo root:
 *
 *   npm run demo:ic-memo
 *
 * Steps: validate fixtures -> build the .docx via officecli -> generate the
 * evidence map / review checklist / run record -> run the acceptance checks
 * from acceptance-checklist.yaml -> print a summary (non-zero exit on any
 * failure) -> best-effort screenshot of the evidence HTML via puppeteer.
 *
 * Illustrative workflow — synthetic data. This pipeline replays pre-drafted
 * fixture content; it does not call any model and needs no credentials or
 * network access.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MemoContent,
  OUTPUT,
  SourceRegistry,
  loadChecklist,
  loadMemoContent,
  loadSources,
  officecli,
  p,
} from "./lib.ts";
import { CHECK_IMPLEMENTATIONS, CheckResult } from "./checks.ts";
import { buildEvidenceMap, writeArtifacts, writeProvenance } from "./artifacts.ts";

// ---------------------------------------------------------------------------
// Step 1 — validate fixtures
// ---------------------------------------------------------------------------

function validateFixtures(memo: MemoContent, registry: SourceRegistry): void {
  const problems: string[] = [];
  const ids = registry.sources.map((s) => s.source_id);
  if (new Set(ids).size !== ids.length) problems.push("duplicate source_id in sources.json");
  const claimIds = memo.claims.map((c) => c.claim_id);
  if (new Set(claimIds).size !== claimIds.length) problems.push("duplicate claim_id in memo-content.json");

  const byId = new Map(registry.sources.map((s) => [s.source_id, s]));
  for (const c of memo.claims) {
    for (const sid of c.source_ids) {
      const s = byId.get(sid);
      if (!s) problems.push(`${c.claim_id} references unknown source ${sid}`);
      else if (!s.approved) problems.push(`${c.claim_id} references excluded source ${sid}`);
    }
    if (c.reviewer_decision !== null) problems.push(`${c.claim_id} has a reviewer_decision in the draft fixtures`);
  }
  if (!registry.sources.some((s) => !s.approved)) problems.push("sources.json must contain at least one excluded source");

  for (const s of registry.sources) {
    if (!s.approved) continue;
    if (!fs.existsSync(p(s.file))) problems.push(`source file missing: ${s.file}`);
  }
  if (!fs.existsSync(p("template", "ic-memo-template.docx"))) problems.push("template/ic-memo-template.docx missing");

  const checklistIds = loadChecklist().map((c) => c.id);
  for (const id of checklistIds) {
    if (!CHECK_IMPLEMENTATIONS[id]) problems.push(`acceptance-checklist.yaml check "${id}" has no implementation`);
  }
  for (const id of Object.keys(CHECK_IMPLEMENTATIONS)) {
    if (!checklistIds.includes(id)) problems.push(`check implementation "${id}" missing from acceptance-checklist.yaml`);
  }

  if (problems.length > 0) {
    for (const prob of problems) console.error(`  fixture problem: ${prob}`);
    throw new Error(`fixture validation failed with ${problems.length} problem(s)`);
  }
  console.log(`  fixtures OK: ${registry.sources.filter((s) => s.approved).length} approved sources, ` +
    `${registry.sources.filter((s) => !s.approved).length} excluded, ${memo.claims.length} claims, ` +
    `${checklistIds.length} acceptance checks declared`);
}

// ---------------------------------------------------------------------------
// Step 2 — build the .docx from the template + memo content
// ---------------------------------------------------------------------------

interface BatchCommand {
  command: string;
  parent?: string;
  path?: string;
  type?: string;
  props?: Record<string, string>;
}

function buildDocx(memo: MemoContent): void {
  const docx = p(OUTPUT.docx);
  fs.copyFileSync(p("template", "ic-memo-template.docx"), docx);

  const cmds: BatchCommand[] = [];
  const addP = (props: Record<string, string>) => cmds.push({ command: "add", parent: "/body", type: "paragraph", props });

  addP({ text: memo.subtitle, style: "Subtitle" });
  addP({ text: memo.date_line, size: "9", italic: "true", color: "#666666" });

  let tableIndex = 0;
  for (const section of memo.sections) {
    addP({ text: section.heading, style: "Heading1" });
    for (const text of section.paragraphs ?? []) addP({ text });
    for (const text of section.bullets ?? []) addP({ text, listStyle: "bullet" });

    if (section.table_claim_ids) {
      tableIndex += 1;
      const claims = section.table_claim_ids.map((id) => {
        const c = memo.claims.find((cl) => cl.claim_id === id);
        if (!c?.table) throw new Error(`table claim ${id} missing or has no table row`);
        return c;
      });
      const rows = claims.length + 1;
      cmds.push({
        command: "add",
        parent: "/body",
        type: "table",
        props: { rows: String(rows), cols: "4", colWidths: "2100,1750,2800,1650", layout: "fixed" },
      });
      const tbl = `/body/tbl[${tableIndex}]`;
      const header = ["Metric", "Value", "Source", "Status"];
      header.forEach((text, i) => {
        cmds.push({
          command: "set",
          path: `${tbl}/tr[1]/tc[${i + 1}]`,
          props: { text, bold: "true", color: "#FFFFFF", fill: "#1F3864" },
        });
      });
      claims.forEach((c, r) => {
        const row = c.table!;
        const cells = [row.metric, row.value, row.source, row.status];
        cells.forEach((text, i) => {
          cmds.push({ command: "set", path: `${tbl}/tr[${r + 2}]/tc[${i + 1}]`, props: { text, size: "10" } });
        });
      });
    }
  }

  const res = officecli(["batch", docx, "--commands", JSON.stringify(cmds)]);
  if (/"success":\s*false/i.test(res.stdout)) throw new Error(`docx batch reported a failure:\n${res.stdout}`);
  officecli(["close", docx], { allowFail: true });
  console.log(`  built ${OUTPUT.docx} (${cmds.length} officecli operations)`);
}

// ---------------------------------------------------------------------------
// Step 6 — best-effort screenshot of the evidence HTML
// ---------------------------------------------------------------------------

async function screenshotEvidence(): Promise<void> {
  const target = p("screenshots", "evidence-report.png");
  try {
    const puppeteer = (await import("puppeteer")).default;
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(pathToFileURL(p(OUTPUT.evidenceHtml)).href, { waitUntil: "networkidle0" });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await page.screenshot({ path: target as `${string}.png`, fullPage: true });
      console.log(`  screenshot written: screenshots/evidence-report.png`);
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.warn(`  screenshot skipped (best-effort): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Investment committee memo demo — Illustrative workflow, synthetic data\n");

  const memo = loadMemoContent();
  const registry = loadSources();

  console.log("[1/6] Validating fixtures");
  validateFixtures(memo, registry);

  // SPEC §12.4 drift detection: halt before drafting if a source's structure
  // has changed since the workflow was authored, so we never silently produce
  // a memo with broken lineage.
  console.log("[2/6] Checking source drift against expected-structure.json");
  const { checkDrift, loadExpectedStructure } = await import("../../../src/workflow/drift.js");
  const expected = loadExpectedStructure(p("."));
  if (expected) {
    const drift = checkDrift(expected, p("inputs"));
    console.log(`  ${drift.summary}`);
    if (drift.drifted) {
      console.error("\n  HALT — source drift detected. Fix the source or update expected-structure.json.");
      for (const m of drift.mismatches) console.error(`    • ${m.source}: expected ${m.expected}, actual ${m.actual} — ${m.reason}`);
      process.exit(1);
    }
  } else {
    console.log("  no expected-structure.json — drift check skipped");
  }

  console.log("[3/6] Building the memo .docx");
  fs.rmSync(p(OUTPUT.dir), { recursive: true, force: true });
  fs.mkdirSync(p(OUTPUT.dir), { recursive: true });
  buildDocx(memo);

  console.log("[4/6] Generating evidence map, review checklist, run record");
  const evidence = buildEvidenceMap(memo, registry);
  writeArtifacts(evidence);
  console.log(`  wrote ${OUTPUT.evidenceJson}`);
  console.log(`  wrote ${OUTPUT.evidenceHtml}`);
  console.log(`  wrote ${OUTPUT.reviewChecklist}`);
  console.log(`  wrote ${OUTPUT.reviewChecklistHtml}`);
  console.log(`  wrote ${OUTPUT.runRecord}`);

  console.log("[5/6] Running acceptance checks");
  const checklist = loadChecklist();
  const results: CheckResult[] = [];
  for (const entry of checklist) {
    let result: CheckResult;
    try {
      result = CHECK_IMPLEMENTATIONS[entry.id]({ memo, registry });
    } catch (err) {
      result = { id: entry.id, pass: false, detail: `check threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    results.push(result);
    console.log(`  [${result.pass ? "PASS" : "FAIL"}] ${entry.name} (${entry.id})`);
    console.log(`         ${result.detail}`);
  }
  officecli(["close", p("inputs", "Model_v12.xlsx")], { allowFail: true });

  // The provenance page carries the real pass state of each check, so it is
  // written after the checks run.
  writeProvenance(evidence, results.map((r) => ({ id: r.id, pass: r.pass })));
  console.log(`  wrote ${OUTPUT.provenanceHtml}`);

  console.log("\n[5/5] Summary");
  const failed = results.filter((r) => !r.pass);
  console.log(`  checks: ${results.length - failed.length}/${results.length} passed`);
  for (const f of [
    OUTPUT.docx,
    OUTPUT.evidenceJson,
    OUTPUT.evidenceHtml,
    OUTPUT.reviewChecklist,
    OUTPUT.reviewChecklistHtml,
    OUTPUT.runRecord,
    OUTPUT.provenanceHtml,
  ]) {
    console.log(`  output: examples/investment-committee-memo/${f}`);
  }

  await screenshotEvidence();

  if (failed.length > 0) {
    console.error(`\n${failed.length} acceptance check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll acceptance checks passed. Draft is ready for human review.");
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
