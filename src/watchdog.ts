/**
 * Watchdog integration — lets the agent (and the user via /watchdog) read and
 * drain the findings queue produced by `scripts/watchdog.ts`.
 *
 * The watchdog is a detached loop that appends one JSON finding per line to
 * `<project>/.quiver/watchdog-queue.jsonl` every cycle (default 300s). This
 * module reads that queue, groups findings for display, and optionally
 * truncates it once findings have been triaged.
 *
 * Paths: the watchdog writes to `<projectDir>/.quiver/`. We resolve the
 * project dir as process.cwd() (the agent and the watchdog both run from the
 * repo root), with a hardcoded fallback to the known project path so a
 * different CWD can't hide the queue.
 */

import * as fs from "fs";
import * as path from "path";
import picocolors from "picocolors";

const FALLBACK_PROJECT_DIR = "/Users/rahul/quiver";

function watchdogDir(): string {
  const candidates = [
    path.join(process.cwd(), ".quiver"),
    path.join(FALLBACK_PROJECT_DIR, ".quiver"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[0];
}

export const WATCHDOG_QUEUE_PATH = path.join(watchdogDir(), "watchdog-queue.jsonl");
export const WATCHDOG_HEARTBEAT_PATH = path.join(watchdogDir(), "watchdog.heartbeat");
export const WATCHDOG_SEEN_PATH = path.join(watchdogDir(), "watchdog.seen.json");

export interface WatchdogFinding {
  t: string;
  kind: string;
  key: string;
  severity: string;
  detail: string;
}

/** Read and parse the findings queue. Returns [] if absent/unreadable. */
export function readQueue(): WatchdogFinding[] {
  try {
    const raw = fs.readFileSync(WATCHDOG_QUEUE_PATH, "utf8");
    const out: WatchdogFinding[] = [];
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Truncate the queue file (called after triage so old findings don't recur). */
export function clearQueue(): boolean {
  try {
    fs.writeFileSync(WATCHDOG_QUEUE_PATH, "", "utf8");
    return true;
  } catch {
    return false;
  }
}

export interface HeartbeatInfo {
  alive: boolean;
  ageSec: number | null;
  cycle: number | null;
  ok: boolean | null;
  note: string | null;
  pid: number | null;
  intervalMs: number | null;
}

/** Read the heartbeat file and infer liveness (alive if mtime within 2× interval). */
export function readHeartbeat(): HeartbeatInfo {
  const info: HeartbeatInfo = {
    alive: false,
    ageSec: null,
    cycle: null,
    ok: null,
    note: null,
    pid: null,
    intervalMs: null,
  };
  let raw: string;
  try {
    raw = fs.readFileSync(WATCHDOG_HEARTBEAT_PATH, "utf8");
  } catch {
    return info;
  }
  let hb: any;
  try {
    hb = JSON.parse(raw);
  } catch {
    return info;
  }
  info.cycle = hb.cycle ?? null;
  info.ok = hb.ok ?? null;
  info.note = hb.note ?? null;
  info.pid = hb.pid ?? null;
  info.intervalMs = hb.intervalMs ?? null;
  // Age from the heartbeat's own timestamp (more robust than file mtime).
  if (hb.t) {
    const ageMs = Date.now() - new Date(hb.t).getTime();
    info.ageSec = Math.max(0, Math.round(ageMs / 1000));
    const interval = hb.intervalMs ?? 300_000;
    // Alive if last heartbeat within 2× interval (one missed cycle tolerated).
    info.alive = ageMs >= 0 && ageMs <= interval * 2;
  }
  return info;
}

/** Build a human-readable summary of the queue, grouped by kind then severity. */
export function summarizeQueue(findings: WatchdogFinding[]): string {
  if (findings.length === 0) return "";
  const byKind = new Map<string, WatchdogFinding[]>();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind)!.push(f);
  }
  const lines: string[] = [];
  const sevColor = (s: string) =>
    s === "error"
      ? picocolors.red(s)
      : s === "warn"
        ? picocolors.yellow(s)
        : picocolors.green(s);
  for (const [kind, list] of byKind) {
    const errs = list.filter((f) => f.severity === "error").length;
    const warns = list.filter((f) => f.severity === "warn").length;
    const infos = list.filter((f) => f.severity === "info").length;
    const tag =
      errs > 0
        ? picocolors.red(`(${errs} error${errs > 1 ? "s" : ""})`)
        : warns > 0
          ? picocolors.yellow(`(${warns} warn)`)
          : picocolors.green("(ok)");
    lines.push(`  ${picocolors.cyan(kind)} ${tag}`);
    for (const f of list) {
      lines.push(
        `     ${sevColor(f.severity)} ${picocolors.gray(f.key)} — ${f.detail}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Full status string for the /watchdog command. If `clearAfter` is true,
 * truncates the queue after reading (used by /watchdog clear).
 */
export function watchdogStatus(opts: { clearAfter?: boolean } = {}): string {
  const hb = readHeartbeat();
  const findings = readQueue();
  const out: string[] = [];
  out.push(picocolors.cyan("\n  Watchdog"));
  if (hb.alive) {
    out.push(
      picocolors.green("   ● alive") +
        picocolors.gray(
          ` — cycle ${hb.cycle}, last beat ${hb.ageSec}s ago, interval ${Math.round((hb.intervalMs ?? 0) / 1000)}s, pid ${hb.pid}`,
        ),
    );
  } else if (hb.cycle !== null) {
    out.push(
      picocolors.red("   ○ not alive") +
        picocolors.gray(
          ` — last heartbeat ${hb.ageSec}s ago (pid ${hb.pid}). Start with \`npm run watchdog\` or the launchd agent.`,
        ),
    );
  } else {
    out.push(
      picocolors.yellow(
        "   ○ no heartbeat found — watchdog not started. Run `npm run watchdog`.",
      ),
    );
  }
  if (findings.length === 0) {
    out.push(picocolors.gray("   Queue empty — no findings to triage."));
  } else {
    out.push(
      picocolors.gray(
        `   Queue: ${findings.length} finding(s) since last drain:`,
      ),
    );
    out.push(summarizeQueue(findings));
  }
  if (opts.clearAfter) {
    const ok = clearQueue();
    out.push(
      ok
        ? picocolors.green("\n   ✓ Queue drained.")
        : picocolors.red("\n   ✗ Could not clear queue."),
    );
  }
  out.push(
    picocolors.gray(
      "\n   Commands: /watchdog (show) · /watchdog clear · /watchdog status",
    ),
  );
  return out.join("\n");
}