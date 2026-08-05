/**
 * OfficeCLI packaging verification — Phase 6 (ADR-006).
 *
 * End-to-end test of the pinned-binary bundling script: with a populated
 * checksum, the binary is verified and bundled with a manifest (background
 * self-updates disabled); with an empty/mismatched checksum the script fails
 * closed. Uses a fake binary so no real OfficeCLI is required.
 */
import picocolors from "picocolors";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";
import { execFileSync } from "child_process";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  const script = path.resolve("scripts/bundle-officecli.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-pack-"));
  const fakeBin = path.join(tmp, "officecli");
  fs.writeFileSync(fakeBin, Buffer.from("fake-officecli-binary-bytes"));
  const realChecksum = createHash("sha256").update(fs.readFileSync(fakeBin)).digest("hex");
  const outDir = path.join(tmp, "bundle");

  // ── Empty checksum → fail closed (exit 1) ───────────────────────────
  let emptyExit = 0;
  try { execFileSync("node", [script, "--binary", fakeBin, "--platform", "darwin", "--out", outDir], { encoding: "utf8" }); }
  catch (e: any) { emptyExit = e.status ?? 1; }
  check("PACK-EMPTY-CHECKSUM-FAIL-CLOSED", emptyExit === 1);

  // ── Mismatched checksum → fail closed (exit 1) ───────────────────────
  // Patch the script's pin in-memory via an env override is not supported, so
  // verify the mismatch path by writing a binary whose content differs from a
  // pinned manifest. We simulate by using a populated-checksum variant script.
  const pinnedScript = path.join(tmp, "bundle-pinned.mjs");
  let src = fs.readFileSync(script, "utf8");
  src = src.replace('darwin: { version: "1.0.0-quiver-pinned", checksum: "" }',
    `darwin: { version: "1.0.0-quiver-pinned", checksum: "${realChecksum}" }`);
  fs.writeFileSync(pinnedScript, src);

  // Correct checksum → bundle succeeds.
  execFileSync("node", [pinnedScript, "--binary", fakeBin, "--platform", "darwin", "--out", outDir], { encoding: "utf8" });
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  check("PACK-BUNDLE-MANIFEST", manifest.platform === "darwin" && manifest.backgroundUpdates === "disabled" && manifest.checksum === realChecksum);
  check("PACK-BUNDLE-COPIED-BINARY", fs.existsSync(path.join(outDir, `officecli-darwin-${manifest.version}`)));

  // Mismatched checksum (different binary) → fail closed.
  const otherBin = path.join(tmp, "officecli-other");
  fs.writeFileSync(otherBin, Buffer.from("different-bytes"));
  let mismatchExit = 0;
  try { execFileSync("node", [pinnedScript, "--binary", otherBin, "--platform", "darwin", "--out", outDir], { encoding: "utf8" }); }
  catch (e: any) { mismatchExit = e.status ?? 1; }
  check("PACK-MISMATCH-CHECKSUM-FAIL-CLOSED", mismatchExit === 1);

  // ── Missing args → exit 2 ────────────────────────────────────────────
  let usageExit = 0;
  try { execFileSync("node", [script], { encoding: "utf8" }); }
  catch (e: any) { usageExit = e.status ?? 1; }
  check("PACK-USAGE-EXIT-2", usageExit === 2);

  fs.rmSync(tmp, { recursive: true, force: true });
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} packaging check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} packaging checks passed.`));
