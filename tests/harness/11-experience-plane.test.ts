/**
 * Experience plane tests — Phase 8 (ADR-009).
 *
 * Loopback-only binding, per-install secret + CSRF enforcement, strict origin
 * validation, secure headers, path-traversal guard, UI serving, and the
 * launcher status/diagnostics. No LAN exposure.
 */
import picocolors from "picocolors";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { QuiverDaemon, loadOrCreateSecret } from "../../src/harness/daemon.js";
import { QuiverLauncher, runLauncherCli } from "../../src/harness/launcher.js";
import * as net from "net";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function get(url: string, opts: { headers?: Record<string, string> } = {}): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  const res = await fetch(url, { headers: opts.headers });
  const text = await res.text();
  let body: any; try { body = JSON.parse(text); } catch { body = text; }
  const headers: Record<string, string | string[] | undefined> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body, headers };
}

async function run() {
  const uiDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "src", "harness", "ui");
  const daemon = new QuiverDaemon({ secret: "test-secret-123", roots: [os.homedir()], uiDir });
  const { port, origin } = await daemon.listen();

  // ── Loopback binding: server address is 127.0.0.1 ───────────────────
  check("DAEMON-LOOPBACK-ORIGIN", /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));

  // ── Health is public (no secret) ────────────────────────────────────
  const health = await get(`${origin}/health`);
  check("DAEMON-HEALTH-OK", health.status === 200 && health.body.status === "ok" && health.body.loopback === true);

  // ── Secure headers ──────────────────────────────────────────────────
  check("DAEMON-HEADER-NOSNIFF", health.headers["x-content-type-options"] === "nosniff");
  check("DAEMON-HEADER-FRAME-DENY", health.headers["x-frame-options"] === "DENY");
  check("DAEMON-HEADER-NO-REFERRER", health.headers["referrer-policy"] === "no-referrer");
  check("DAEMON-HEADER-NO-STORE", health.headers["cache-control"] === "no-store");

  // ── API GET without secret → 401 ────────────────────────────────────
  const noSecret = await get(`${origin}/api/roots`);
  check("DAEMON-API-REQUIRES-SECRET", noSecret.status === 401);

  // ── API GET with secret → 200 ───────────────────────────────────────
  const withSecret = await get(`${origin}/api/roots`, { headers: { "X-Quiver-Secret": "test-secret-123" } });
  check("DAEMON-API-WITH-SECRET", withSecret.status === 200 && Array.isArray(withSecret.body.roots));

  // ── Wrong secret → 401 (timing-safe) ────────────────────────────────
  const wrongSecret = await get(`${origin}/api/roots`, { headers: { "X-Quiver-Secret": "wrong" } });
  check("DAEMON-WRONG-SECRET-401", wrongSecret.status === 401);

  // ── State change without secret → 401 (CSRF) ────────────────────────
  const postNoSecret = await fetch(`${origin}/api/roots`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("DAEMON-CSRF-BLOCKS-NO-SECRET", postNoSecret.status === 401);

  // ── UI index served (GET / no secret needed for the page) ───────────
  const index = await get(`${origin}/`);
  check("DAEMON-UI-INDEX-SERVED", index.status === 200 && /<html/i.test(String(index.body)));

  // ── UI asset served with correct content-type ───────────────────────
  const css = await get(`${origin}/ui/styles.css`);
  check("DAEMON-UI-ASSET-CSS", css.status === 200 && String(css.headers["content-type"] ?? "").includes("text/css"));

  // ── Path traversal in UI asset → 403 ────────────────────────────────
  const traversal = await get(`${origin}/ui/../../../etc/passwd`);
  check("DAEMON-UI-PATH-TRAVERSAL-BLOCKED", traversal.status === 403 || traversal.status === 404);

  // ── Non-loopback Host header → 403 (raw socket; fetch forbids Host override) ─
  const badHostStatus = await new Promise<number>((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write("GET /health HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n");
    });
    let buf = "";
    sock.on("data", (d) => { buf += d.toString(); });
    sock.on("end", () => resolve(parseInt(buf.split(" ")[1] ?? "0", 10)));
    sock.on("error", () => resolve(0));
  });
  check("DAEMON-NON-LOOPBACK-HOST-BLOCKED", badHostStatus === 403);

  await daemon.close();

  // ── Per-install secret persistence ──────────────────────────────────
  const secretPath = path.join(os.tmpdir(), "quiver-secret-" + Math.random().toString(36).slice(2));
  const s1 = loadOrCreateSecret(secretPath);
  const s2 = loadOrCreateSecret(secretPath);
  check("DAEMON-SECRET-PERSISTENT", s1 === s2 && s1.length === 64);
  fs.unlinkSync(secretPath);

  // ── Launcher CLI ────────────────────────────────────────────────────
  const statePath = path.join(os.tmpdir(), "quiver-launcher-" + Math.random().toString(36).slice(2) + ".json");
  const launcher = new QuiverLauncher(statePath);
  check("LAUNCHER-STATUS-NULL-BEFORE-START", launcher.status() === null);
  const cliHelp = await runLauncherCli(["help"]);
  check("LAUNCHER-CLI-HELP", cliHelp === 0);
  const cliUnknown = await runLauncherCli(["bogus"]);
  check("LAUNCHER-CLI-UNKNOWN-COMMAND", cliUnknown === 2);
  launcher.registerWorkspace(os.homedir());
  check("LAUNCHER-REGISTER-WORKSPACE", true); // no throw
  // Diagnostics on a non-running daemon reports unreachable.
  const d = await launcher.diagnostics();
  check("LAUNCHER-DIAGNOSTICS-NOT-RUNNING", !d.daemonReachable);
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} experience check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} experience checks passed.`));