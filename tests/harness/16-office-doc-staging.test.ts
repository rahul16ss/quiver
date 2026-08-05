/**
 * office_doc staging option — Phase 6 safe migration (ADR-005/006).
 *
 * Verifies that with stage:true, office_doc snapshots the source into an
 * isolated working copy and never mutates the original directly (the officecli
 * call itself fails without a binary, but the staging side-effect is what we
 * assert). Default (stage unset) is the legacy direct-write behavior.
 */
import picocolors from "picocolors";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { tool as officeDocTool } from "../../src/tools/office_doc.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  const cwd = fs.mkdtempSync(path.join(process.cwd(), ".quiver-office-stage-tmp"));
  const src = path.join(cwd, "model.xlsx");
  fs.writeFileSync(src, Buffer.from("original-xlsx-bytes"));
  // Point OfficeCLI at a non-existent binary so the edit call fails fast, but
  // staging (which happens before the officecli call) still runs.
  process.env.QUIVER_OFFICECLI_PATH = path.join(cwd, "no-such-binary");

  const res = await officeDocTool.execute({ action: "save", file: src, stage: true, cwd });
  // The officecli call fails (no binary), but staging produced a working copy.
  const stagingRoot = path.join(cwd, ".quiver", "office-staging");
  const workingCopies = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot).filter((d) => fs.statSync(path.join(stagingRoot, d)).isDirectory()) : [];
  check("OFFICE-STAGE-CREATES-WORKING-COPY", workingCopies.length >= 1, `stagingRoot=${stagingRoot} copies=${workingCopies.length}`);
  // The original is never mutated.
  check("OFFICE-STAGE-ORIGINAL-NOT-MUTATED", fs.readFileSync(src, "utf8") === "original-xlsx-bytes");
  // The working copy is an isolated snapshot of the source (not the original).
  const stageDir = path.join(stagingRoot, workingCopies[0]);
  const workingCopy = path.join(stageDir, "working-copy.xlsx");
  check("OFFICE-STAGE-WORKING-COPY-IS-SNAPSHOT", fs.existsSync(workingCopy) && fs.readFileSync(workingCopy, "utf8") === "original-xlsx-bytes");
  // The original is never mutated, even though the officecli edit call failed
  // (no binary) — staging happened before the call, so the source is safe.
  check("OFFICE-STAGE-SOURCE-SAFE-ON-EDIT-FAILURE", fs.readFileSync(src, "utf8") === "original-xlsx-bytes");

  // Default (no stage): legacy behavior — no staging dir created for a fresh cwd.
  const cwd2 = fs.mkdtempSync(path.join(process.cwd(), ".quiver-office-nostage-tmp"));
  const src2 = path.join(cwd2, "model.xlsx");
  fs.writeFileSync(src2, Buffer.from("original"));
  await officeDocTool.execute({ action: "save", file: src2, cwd: cwd2 });
  check("OFFICE-NO-STAGE-NO-STAGING-DIR", !fs.existsSync(path.join(cwd2, ".quiver", "office-staging")));

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(cwd2, { recursive: true, force: true });
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} office-doc staging check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} office-doc staging checks passed.`));
