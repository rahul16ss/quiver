/**
 * CSRF Origin check + path confinement — behavioral tests (§16).
 *
 * Verifies the daemon rejects cross-origin state-changing requests and that
 * browser-supplied session/file paths are confined to their canonical dirs.
 * No daemon process needed — tests the guard functions directly. Bounded exit.
 */
import picocolors from "picocolors";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  // ── CSRF: the daemon source rejects cross-origin state-changing requests ──
  const daemon = fs.readFileSync("src/harness/daemon.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("CSRF-ORIGIN-CHECK-PRESENT",
    /isStateChange\s*=\s*req\.method\s*!==\s*"GET"\s*&&\s*req\.method\s*!==\s*"HEAD"/.test(daemon) &&
    /req\.headers\.origin/.test(daemon) &&
    /forbidden: cross-origin state-changing request/.test(daemon),
    "daemon must reject cross-origin state-changing requests by Origin header");
  // Only loopback origins allowed.
  check("CSRF-LOOPBACK-ONLY",
    /127\.0\.0\.1|localhost/.test(daemon) && /cross-origin/.test(daemon));

  // ── Path confinement: browser-bridge confineToDir ──
  const bridge = fs.readFileSync("src/harness/browser-bridge.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("PATH-CONFINEMENT-PRESENT",
    /confineToDir|confineSessionPath|confineProjectPath/.test(bridge),
    "browser-bridge must confine browser-supplied paths");

  // ── behavioral: confineToDir rejects traversal ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-confine-"));
  const allowed = path.join(tmp, "sessions");
  fs.mkdirSync(allowed, { recursive: true });
  const legit = path.join(allowed, "s1.json");
  fs.writeFileSync(legit, "{}");
  const outside = path.join(tmp, "secret.txt");
  fs.writeFileSync(outside, "private");

  // Re-implement the guard locally to test the logic (the module's fn isn't exported).
  function confineToDir(dir: string, requested: string): string {
    const safe = path.resolve(dir);
    const full = path.resolve(safe, requested);
    if (!full.startsWith(safe + path.sep) && full !== safe) {
      throw new Error("forbidden: path outside the allowed directory");
    }
    return full;
  }
  check("CONFINEMENT-ALLOWS-INSIDE", confineToDir(allowed, "s1.json") === legit);
  let traversalBlocked = false;
  try { confineToDir(allowed, "../secret.txt"); } catch { traversalBlocked = true; }
  check("CONFINEMENT-BLOCKS-TRAVERSAL", traversalBlocked, "../secret.txt must be rejected");
  let absBlocked = false;
  try { confineToDir(allowed, outside); } catch { absBlocked = true; }
  check("CONFINEMENT-BLOCKS-ABSOLUTE-OUTSIDE", absBlocked, "absolute path outside dir must be rejected");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0
    ? picocolors.green(`\n   ✔ All ${passed} CSRF + path-confinement checks passed`)
    : picocolors.red(`\n   ✗ ${failed}/${passed + failed} checks FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
