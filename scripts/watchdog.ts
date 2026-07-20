/**
 * Quiver Watchdog — continuous health monitor.
 *
 * Runs in a loop (default 300s) and appends every finding to a JSONL queue at
 * `<project>/.quiver/watchdog-queue.jsonl`. The pi coding agent drains that
 * queue on demand ("drain the watchdog") and pushes fixes.
 *
 * Design constraints:
 *  - NEVER crashes the loop. Every probe is wrapped; a thrown probe is logged
 *    as its own finding and the loop continues.
 *  - No imports from src/ (decoupled from the build) — plain Node APIs only,
 *    run via `npx tsx scripts/watchdog.ts`.
 *  - Dedupes findings within a run using a stable `key` so a persistent
 *    failure (e.g. tsc error) is recorded once, not every cycle.
 *  - Session-log scan is byte-offset incremental: it only looks at bytes
 *    appended since the last scan, so a long-running session doesn't get
 *    re-scanned from the top each cycle.
 *  - Writes a heartbeat (`watchdog.heartbeat`) each cycle so liveness is
 *    checkable (`stat` mtime).
 *
 * Finding shape (one JSON object per line):
 *   { t, kind, key, severity, detail }
 * kind ∈ tsc | tests | session_errors | process | watchdog
 * severity ∈ info | warn | error
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

const PROJECT_DIR = "/Users/rahul/quiver";
const QUIVER_DIR = path.join(PROJECT_DIR, ".quiver");
const QUEUE_PATH = path.join(QUIVER_DIR, "watchdog-queue.jsonl");
const HEARTBEAT_PATH = path.join(QUIVER_DIR, "watchdog.heartbeat");
const OFFSET_PATH = path.join(QUIVER_DIR, "watchdog.offset.json");
const SEEN_KEYS_PATH = path.join(QUIVER_DIR, "watchdog.seen.json");

const CYCLE_MS = parseInt(process.env.QUIVER_WATCHDOG_INTERVAL_MS || "300000", 10);
const SESSIONS_DIR = path.join(
  os.homedir(),
  ".quiver/projects/quiver/.sessions",
);

// ── Tiny utilities ────────────────────────────────────────────────────

function ensureDirs(): void {
  fs.mkdirSync(QUIVER_DIR, { recursive: true });
}

function appendFinding(f: {
  kind: string;
  key: string;
  severity: string;
  detail: string;
}): void {
  ensureDirs();
  const line =
    JSON.stringify({
      t: new Date().toISOString(),
      kind: f.kind,
      key: f.key,
      severity: f.severity,
      detail: f.detail,
    }) + "\n";
  fs.appendFileSync(QUEUE_PATH, line, "utf8");
}

function loadSeenKeys(): Set<string> {
  try {
    const raw = fs.readFileSync(SEEN_KEYS_PATH, "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSeenKeys(set: Set<string>): void {
  try {
    fs.writeFileSync(SEEN_KEYS_PATH, JSON.stringify([...set], null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Record a finding only if its key hasn't been seen this run-set. */
function recordOnce(
  seen: Set<string>,
  kind: string,
  key: string,
  severity: string,
  detail: string,
): void {
  const full = `${kind}:${key}`;
  if (seen.has(full)) return;
  seen.add(full);
  appendFinding({ kind, key, severity, detail });
  saveSeenKeys(seen);
}

function heartbeat(cycle: number, ok: boolean, note: string): void {
  ensureDirs();
  fs.writeFileSync(
    HEARTBEAT_PATH,
    JSON.stringify(
      {
        t: new Date().toISOString(),
        cycle,
        ok,
        note,
        pid: process.pid,
        intervalMs: CYCLE_MS,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
} {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout: out, stderr: "", code: 0 };
  } catch (err: any) {
    return {
      ok: false,
      stdout: err?.stdout ?? "",
      stderr: err?.stderr ?? err?.message ?? String(err),
      code: err?.status ?? null,
    };
  }
}

// ── Probes ────────────────────────────────────────────────────────────

function probeTsc(seen: Set<string>): void {
  const r = run("npx", ["tsc", "--noEmit"], PROJECT_DIR, 120_000);
  if (r.ok) {
    recordOnce(seen, "tsc", "clean", "info", "tsc --noEmit passed");
    return;
  }
  const errs = (r.stderr || r.stdout || "").trim();
  // Surface each distinct compiler error file so fixes can target them.
  const firstLines = errs.split("\n").filter((l) => /error TS/.test(l)).slice(0, 20);
  if (firstLines.length === 0) {
    recordOnce(seen, "tsc", "fail", "error", `tsc failed: ${errs.slice(0, 800)}`);
    return;
  }
  for (const l of firstLines) {
    const key = l.split("(")[0].trim().slice(0, 120) || "ts-error";
    recordOnce(seen, "tsc", key, "error", l.slice(0, 400));
  }
}

async function probeTests(seen: Set<string>): Promise<void> {
  let r = run("npm", ["test"], PROJECT_DIR, 300_000);
  let combined = (r.stdout + "\n" + r.stderr).trim();
  let passed = r.ok && /All spec acceptance checks passed/.test(combined);
  // Anti-flake: Quiver may be mid-edit on a source file when the probe
  // snapshotted it (a half-written renderer/preload can fail a parse check
  // for a fraction of a second). Re-run once after a short delay; only record
  // a failure if BOTH runs failed. This keeps the watchdog from crying wolf
  // on transient races with the live agent's own writes.
  if (!passed) {
    await new Promise((res) => setTimeout(res, 8000));
    r = run("npm", ["test"], PROJECT_DIR, 300_000);
    combined = (r.stdout + "\n" + r.stderr).trim();
    passed = r.ok && /All spec acceptance checks passed/.test(combined);
  }
  if (passed) {
    recordOnce(seen, "tests", "clean", "info", "npm test: all acceptance checks passed");
    return;
  }
  const failLines = combined
    .split("\n")
    .filter((l) => /✗\s*FAIL/.test(l))
    .slice(0, 25);
  if (failLines.length === 0) {
    recordOnce(
      seen,
      "tests",
      "fail-generic",
      "error",
      `npm test failed (code ${r.code}): ${combined.slice(0, 800)}`,
    );
    return;
  }
  for (const l of failLines) {
    const m = l.match(/\[(.*?)\]\s*([A-Z0-9-]+)/);
    const key = m ? `${m[1]}:${m[2]}` : l.slice(0, 80);
    recordOnce(seen, "tests", key, "error", l.slice(0, 300));
  }
}

type OffsetState = { file: string; offset: number };
function loadOffset(): OffsetState {
  try {
    return JSON.parse(fs.readFileSync(OFFSET_PATH, "utf8"));
  } catch {
    return { file: "", offset: 0 };
  }
}
function saveOffset(s: OffsetState): void {
  try {
    fs.writeFileSync(OFFSET_PATH, JSON.stringify(s, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function newestSessionLog(): string | null {
  try {
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.startsWith("session_") && f.endsWith(".json"))
      .map((f) => ({ f, m: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files[0] ? path.join(SESSIONS_DIR, files[0].f) : null;
  } catch {
    return null;
  }
}

function probeSessionErrors(seen: Set<string>): void {
  const file = newestSessionLog();
  if (!file) {
    recordOnce(seen, "session_errors", "no-log", "warn", "no session log found");
    return;
  }
  const st = { file, offset: loadOffset().offset };
  // If the active log changed, scan from the start of the new file.
  let offset = st.offset;
  const prevFile = loadOffset().file;
  if (prevFile !== file) {
    offset = 0;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (offset > stat.size) offset = 0; // truncated/rotated
  if (offset === stat.size) {
    saveOffset({ file, offset });
    return; // nothing new
  }
  let chunk = "";
  try {
    const fd = fs.openSync(file, "r");
    const len = stat.size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    chunk = buf.toString("utf8");
  } catch {
    return;
  }
  saveOffset({ file, offset: stat.size });

  // Look for error-bearing lines. JSONL-ish (pretty printed) so scan by event.
  const errorPatterns: Array<{ re: RegExp; kind: string; sev: string }> = [
    { re: /Provider error 400.*invalid tool call arguments/, kind: "400-invalid-tool-args", sev: "error" },
    { re: /Provider error 4\d\d/, kind: "provider-4xx", sev: "error" },
    { re: /Provider error 5\d\d/, kind: "provider-5xx", sev: "error" },
    { re: /Connection failed|Connection timeout|Stream stall timeout/, kind: "connection", sev: "warn" },
    { re: /Invalid tool arguments: /, kind: "invalid-tool-args-local", sev: "warn" },
    { re: /tool_failure_diagnostic/, kind: "tool-failure", sev: "warn" },
    { re: /Unsupported event:/, kind: "unsupported-stream-event", sev: "info" },
    { re: /Agent loop failed/, kind: "agent-loop-failed", sev: "error" },
  ];

  const lines = chunk.split("\n");
  const counts: Record<string, number> = {};
  for (const l of lines) {
    for (const p of errorPatterns) {
      if (p.re.test(l)) {
        counts[p.kind] = (counts[p.kind] || 0) + 1;
      }
    }
  }
  for (const [kind, n] of Object.entries(counts)) {
    const p = errorPatterns.find((x) => x.kind === kind)!;
    // key by file+kind so a new session re-records, but same session doesn't spam.
    recordOnce(
      seen,
      "session_errors",
      `${path.basename(file)}:${kind}`,
      p.sev,
      `${n} occurrence(s) of ${kind} in new session-log bytes`,
    );
  }
}

function probeProcess(seen: Set<string>): void {
  const r = run("pgrep", ["-fl", "quiver/src/cli.ts|quiver.*--continue|electron.*quiver"], PROJECT_DIR, 10_000);
  const out = (r.stdout || "").trim();
  if (!out) {
    recordOnce(seen, "process", "no-quiver-process", "warn", "no quiver CLI/electron process running (pgrep empty)");
    return;
  }
  const lines = out.split("\n").filter(Boolean);
  recordOnce(
    seen,
    "process",
    "alive",
    "info",
    `${lines.length} quiver process(es) alive`,
  );
}

// ── Loop ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDirs();
  const seen = loadSeenKeys();
  let cycle = 0;
  // Reset the seen-set at startup so a fresh run re-records the current state
  // once; ongoing persistence then dedupes within/across cycles.
  // (Intentionally NOT clearing here so cross-restart dedup holds; the user
  // can `rm .quiver/watchdog.seen.json` to force a full re-baseline.)

  console.log(`[watchdog] starting (pid ${process.pid}, interval ${CYCLE_MS}ms)`);
  console.log(`[watchdog] queue: ${QUEUE_PATH}`);

  // Run once immediately, then on the cadence.
  while (true) {
    cycle++;
    const t0 = Date.now();
    let ok = true;
    const notes: string[] = [];
    const runProbe = async (name: string, fn: () => void | Promise<void>) => {
      try {
        await fn();
      } catch (err: any) {
        ok = false;
        notes.push(`${name} threw: ${err?.message || String(err)}`);
        appendFinding({
          kind: "watchdog",
          key: `probe-threw:${name}`,
          severity: "error",
          detail: err?.stack || String(err),
        });
      }
    };
    await runProbe("tsc", () => probeTsc(seen));
    await runProbe("tests", () => probeTests(seen));
    await runProbe("session_errors", () => probeSessionErrors(seen));
    await runProbe("process", () => probeProcess(seen));
    const note = notes.length ? notes.join("; ") : "all probes ran";
    heartbeat(cycle, ok, note);
    const dt = Date.now() - t0;
    console.log(`[watchdog] cycle ${cycle} done in ${dt}ms — ${ok ? "ok" : "issues"}`);
    await new Promise((r) => setTimeout(r, Math.max(0, CYCLE_MS - dt)));
  }
}

main().catch((err) => {
  // Should be unreachable (loop swallows), but guard the process.
  console.error("[watchdog] fatal:", err);
  appendFinding({
    kind: "watchdog",
    key: "fatal",
    severity: "error",
    detail: err?.stack || String(err),
  });
  process.exit(1);
});