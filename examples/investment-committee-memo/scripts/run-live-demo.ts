/**
 * Live-draft demo — drafts an IC-memo .docx from a REAL tool run, not from
 * replayed fixtures. Run from the repo root:
 *
 *   npm run demo:ic-memo:live
 *
 * What makes this "live" (vs. the fixture-replay `demo:ic-memo`):
 *   - The Evidence.json + Run_Record.json are emitted by the real
 *     `EvidenceTracker` (`src/evidence/tracker.ts`) — the same tracker the
 *     agent's `evidence` tool drives during a live run — by registering
 *     sources, recording claims, validating, and finalizing.
 *   - The .docx is built via officecli batch (the live office_doc tool path).
 *   - Provenance is written to a tamper-evident `AuditChain`
 *     (`src/audit_chain.ts`) and verified, including the provenance fields —
 *     proving SPEC §11.3 end-to-end.
 *   - The live Evidence.json is parsed and asserted to carry the structured
 *     claims + sources the GUI renders as lineage chips and the §8.3
 *     verification rail — proving the trust story renders from live output.
 *
 * The source/claim DATA is the committed fixture content (synthetic), but it
 * flows through the real tool implementations. No model call and no
 * credentials are required, so the demo is deterministic.
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
import {
  buildEvidenceMap,
  renderEvidenceHtml,
  renderReviewChecklist,
  renderReviewChecklistHtml,
  writeProvenance,
} from "./artifacts.ts";
import { EvidenceTracker } from "../../../src/evidence/tracker.js";
import type { SourceRecord, ClaimRecord } from "../../../src/evidence/model.js";
import { AuditChain } from "../../../src/audit_chain.js";

// ---------------------------------------------------------------------------
// Step 1 — drive the LIVE EvidenceTracker (the same tracker the agent's
// `evidence` tool uses) to emit Evidence.json + Run_Record.json.
// ---------------------------------------------------------------------------

function driveLiveTracker(memo: MemoContent, registry: SourceRegistry): void {
  const tracker = new EvidenceTracker();
  tracker.setMetadata({
    workflow: memo.workflow,
    company: memo.company,
    title: memo.title,
    subtitle: memo.subtitle,
    asOf: memo.as_of,
  });

  // Register every source the registry declares (approved + excluded).
  for (const s of registry.sources) {
    const source: SourceRecord = {
      source_id: s.source_id,
      source_type: s.source_type,
      title: s.title,
      file: s.file,
      as_of: s.as_of,
      location: s.location,
      sensitivity: s.sensitivity,
      approved: s.approved,
      ...(s.extracted_value ? { extracted_value: s.extracted_value } : {}),
      ...(s.excerpt ? { excerpt: s.excerpt } : {}),
      ...(s.exclusion_reason ? { exclusion_reason: s.exclusion_reason } : {}),
    };
    tracker.registerSource(source);
  }

  // Record every claim the memo carries, flowing through the live tracker.
  for (const c of memo.claims) {
    const claim: ClaimRecord = {
      claim_id: c.claim_id,
      rendered_text: c.rendered_text,
      source_ids: c.source_ids,
      relationship: c.relationship,
      review_status: c.review_status,
      reviewer_decision: c.reviewer_decision,
      is_quantitative: c.is_quantitative,
      ...(c.review_note ? { review_note: c.review_note } : {}),
      ...(c.verification ? { verification: c.verification as any } : {}),
      ...(c.table ? { table: c.table } : {}),
    };
    tracker.recordClaim(claim);
  }

  // Register the input files (SHA-256 hashed by the tracker). Pass the
  // workflow-relative path so the run record matches the acceptance check's
  // expected `file` field; the tracker resolves it for hashing.
  for (const f of [
    "inputs/Model_v12.xlsx",
    "inputs/10q-excerpt.md",
    "inputs/earnings-call-q2-transcript.md",
    "inputs/internal-model-note.md",
    "inputs/comps.csv",
  ]) {
    tracker.registerInput(f);
  }

  // Validate live: every quantitative claim has an approved source or is flagged.
  const validation = tracker.validateEvidence();
  if (!validation.valid) {
    throw new Error(
      `live evidence validation failed:\n${validation.problems.map((x) => `  - ${x}`).join("\n")}`,
    );
  }

  // Finalize: writes <base>_Evidence.json + <base>_Run_Record.json live.
  // Use the canonical "Project_Alder" base so the output matches the paths
  // the acceptance checks read (Project_Alder_Evidence.json /
  // Project_Alder_Run_Record.json), distinct from the .docx filename.
  const result = tracker.finalize(p(OUTPUT.dir), "Project_Alder.docx");
  if (!result.evidencePath.endsWith("Project_Alder_Evidence.json")) {
    throw new Error(`unexpected evidence path: ${result.evidencePath}`);
  }
  console.log(
    `  live EvidenceTracker finalized: ${path.relative(p(), result.evidencePath)} + ${path.relative(p(), result.runRecordPath || "")}`,
  );
  console.log(`  live validation: ${validation.summary}`);
}

// ---------------------------------------------------------------------------
// Step 2 — build the .docx via officecli batch (the live office_doc tool path)
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
// Step 3 — tamper-evident provenance (SPEC §11.3). Write the deliverable's
// provenance to a real AuditChain, verify it, then prove tampering a
// provenance convenience field breaks verification.
// ---------------------------------------------------------------------------

function proveTamperEvidentProvenance(memo: MemoContent, registry: SourceRegistry): void {
  const chain = new AuditChain();
  const sourceIds = registry.sources.filter((s) => s.approved).map((s) => s.source_id);
  const sourceRefs = registry.sources
    .filter((s) => s.approved)
    .map((s) => `${s.file}!${s.location.sheet || ""}${s.location.cell ? "!" + s.location.cell : ""}`.replace(/!$/, ""));
  const contextUsed = memo.claims.map((c) => c.rendered_text).join("; ").slice(0, 500);
  const payload = JSON.stringify({
    deliverable: OUTPUT.docx,
    source_ids: sourceIds,
    source_refs: sourceRefs,
    context_used: contextUsed,
    evidence_ref: OUTPUT.evidenceJson,
    provenance: `${sourceIds.length} sources → ${OUTPUT.docx}`,
  });
  const entry = chain.appendEntry("evidence", payload);
  // Derive convenience fields from the hashed payload (as the logger does).
  const reflected = JSON.parse(entry.action_payload);
  entry.source_ids = reflected.source_ids;
  entry.source_refs = reflected.source_refs;
  entry.context_used = reflected.context_used;
  entry.evidence_ref = reflected.evidence_ref;
  entry.provenance = reflected.provenance;

  if (!chain.verifyChain()) throw new Error("audit chain did not verify after provenance was appended");

  // Tamper a provenance convenience field: the reviewer reads entry.source_ids,
  // so altering it must break verification (SPEC §11.3 tamper-evidence).
  const tampered = AuditChain.deserialize(chain.serialize());
  tampered.getEntries().find((e) => e.action_type === "evidence")!.source_ids = ["FAKE-SRC"];
  if (tampered.verifyChain()) throw new Error("tamper-evidence FAILED: editing source_ids did not break the chain");

  // Tamper the payload itself must also break verification.
  const tampered2 = AuditChain.deserialize(chain.serialize());
  const evEntry = tampered2.getEntries().find((e) => e.action_type === "evidence")!;
  evEntry.action_payload = evEntry.action_payload.replace("Project_Alder", "TAMPERED");
  if (tampered2.verifyChain()) throw new Error("tamper-evidence FAILED: editing the payload did not break the chain");

  console.log(
    `  tamper-evident provenance: chain verifies; tampering source_ids OR payload breaks it (${sourceIds.length} sources logged)`,
  );
}

// ---------------------------------------------------------------------------
// Step 4 — prove the live Evidence.json renders lineage chips + the §8.3 rail
// ---------------------------------------------------------------------------

function proveLiveEvidenceRenders(): void {
  const ev = JSON.parse(fs.readFileSync(p(OUTPUT.evidenceJson), "utf8"));
  if (ev.generated_by !== "live_agent") throw new Error("Evidence.json not generated by the live agent path");
  if (!Array.isArray(ev.claims) || ev.claims.length === 0) throw new Error("live Evidence.json has no claims");
  if (!Array.isArray(ev.sources) || ev.sources.length === 0) throw new Error("live Evidence.json has no sources");
  const byId = new Map(ev.sources.map((s: any) => [s.source_id, s]));
  for (const c of ev.claims) {
    if (!Array.isArray(c.source_ids)) throw new Error(`claim ${c.claim_id} has no source_ids (chips cannot render)`);
    for (const sid of c.source_ids) {
      const s = byId.get(sid);
      if (!s) throw new Error(`claim ${c.claim_id} cites unknown source ${sid}`);
      if (s.file === undefined || s.location === undefined)
        throw new Error(`source ${sid} missing file/location (verification rail cannot render)`);
    }
  }
  console.log(
    `  live Evidence.json renders: ${ev.claims.length} claims, ${ev.sources.length} sources, all source_ids resolve to a file+location`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Investment committee memo — LIVE tool run (synthetic data, real tools)\n");

  // Run with the example directory as cwd so the live EvidenceTracker's
  // relative input paths resolve for hashing (the tracker stores the
  // relative path in the run record, matching the acceptance checks).
  process.chdir(p());

  const memo = loadMemoContent();
  const registry = loadSources();

  console.log("[1/6] Driving the live EvidenceTracker (register sources → record claims → finalize)");
  fs.rmSync(p(OUTPUT.dir), { recursive: true, force: true });
  fs.mkdirSync(p(OUTPUT.dir), { recursive: true });
  driveLiveTracker(memo, registry);

  console.log("[2/6] Building the memo .docx via officecli (live office_doc tool path)");
  buildDocx(memo);

  console.log("[3/6] Writing buyer-facing artifacts (evidence HTML, review checklist, provenance)");
  const ev = buildEvidenceMap(memo, registry);
  fs.writeFileSync(p(OUTPUT.evidenceHtml), renderEvidenceHtml(ev));
  fs.writeFileSync(p(OUTPUT.reviewChecklist), renderReviewChecklist(ev));
  fs.writeFileSync(p(OUTPUT.reviewChecklistHtml), renderReviewChecklistHtml(ev));

  console.log("[4/6] Proving tamper-evident provenance (SPEC §11.3)");
  proveTamperEvidentProvenance(memo, registry);

  console.log("[5/6] Running acceptance checks against the live output");
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

  writeProvenance(ev, results.map((r) => ({ id: r.id, pass: r.pass })));
  console.log(`  wrote ${OUTPUT.provenanceHtml}`);

  console.log("[6/6] Proving the live Evidence.json renders lineage chips + the verification rail");
  proveLiveEvidenceRenders();

  console.log("\nSummary");
  const failed = results.filter((r) => !r.pass);
  console.log(`  acceptance checks: ${results.length - failed.length}/${results.length} passed`);
  console.log(`  live artifacts: ${OUTPUT.docx}, ${OUTPUT.evidenceJson}, ${OUTPUT.runRecord}`);
  console.log(`  the lineage chips, verification rail, and review flow render from this live output.`);

  if (failed.length > 0) {
    console.error(`\n${failed.length} acceptance check(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nLive-draft demo passed. The trust story works end-to-end from a real tool run.");
}

main().catch((err) => {
  console.error(`\nLive-draft demo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});