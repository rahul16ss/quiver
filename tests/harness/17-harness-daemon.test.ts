/**
 * HarnessDaemon API tests — Phase 8 (ADR-009).
 *
 * Drives a real goal-seeking run through the loopback, secret-gated daemon API:
 * list the twelve workflows, start a run (ExecutionEngine with mock model +
 * tools), inspect the paused state, approve via the API, and confirm the run
 * completes. Proves the browser UI can replace the Electron interactive surface.
 */
import picocolors from "picocolors";
import * as os from "os";
import * as path from "path";
import { HarnessDaemon } from "../../src/harness/harness-daemon.js";
import { QuiverExecutionEngine, type ToolExecutor, type ToolResult } from "../../src/harness/execution-engine.js";
import { SqliteCheckpointSaver } from "../../src/harness/sqlite-checkpoint.js";
import { LocalTraceSink } from "../../src/harness/trace-sink.js";
import { DurableJobScheduler } from "../../src/harness/durable-job.js";
import type { ModelClient, ModelMessage, ModelResult, ModelProfileRef } from "../../src/harness/interfaces.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

class MockModel implements ModelClient {
  id = "mock"; kind = "local" as const;
  listProfiles(): ModelProfileRef[] { return [{ slug: "local-private-default", label: "local", providerOrder: ["Local"], zdrEligible: true, checkerEligible: true }]; }
  async invoke(messages: ModelMessage[]): Promise<ModelResult> {
    const last = messages[messages.length - 1];
    const c = typeof last.content === "string" ? last.content : "";
    return { content: /checker/i.test(c) ? "OK all met" : "ack", modelProfile: "local-private-default", route: "local" };
  }
}
class MockTools implements ToolExecutor {
  available() { return ["office_doc", "evidence", "deep_research"]; }
  async call(n: string, a: Record<string, unknown>): Promise<ToolResult> { return { ok: true, output: `${n}:${a.step}`, evidenceRefs: [`e-${a.step}`] }; }
}

async function apiCall(origin: string, secret: string, pathname: string, method = "GET", body?: unknown) {
  const res = await fetch(`${origin}${pathname}`, { method, headers: { "X-Quiver-Secret": secret, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

async function run() {
  const saver = new SqliteCheckpointSaver(path.join(os.tmpdir(), "q-hd-" + Math.random().toString(36).slice(2), "c.db"));
  const engine = new QuiverExecutionEngine(saver, new MockModel(), new MockTools(), { maxIterations: 20 });
  const hd = new HarnessDaemon({ engine, uiDir: path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "src", "harness", "ui") });
  const { port, origin } = await hd.listen();
  // The daemon generates a per-install secret; read it for API calls.
  const secret = (hd as any).opts.secret ?? (hd as any).daemon.secret;

  // ── List the twelve workflows ───────────────────────────────────────
  const wf = await apiCall(origin, secret, "/api/workflows");
  check("HD-LIST-WORKFLOWS-IS-TWELVE", wf.body.length === 12);

  // ── API requires the secret ──────────────────────────────────────────
  const noSecret = await fetch(`${origin}/api/workflows`);
  check("HD-API-REQUIRES-SECRET", noSecret.status === 401);

  // ── Start a run (earnings-update) → pauses at approval ─────────────
  const started = await apiCall(origin, secret, "/api/run/start", "POST", { workflowId: "earnings-update" });
  check("HD-START-RUN-PAUSES", started.body.status === "paused", `status=${started.body.status}`);
  const runId = started.body.runId;

  // ── Inspect state shows pending approval ─────────────────────────────
  const state = await apiCall(origin, secret, "/api/run/state", "POST", { runId });
  check("HD-STATE-PENDING-APPROVAL", state.body?.pendingApprovals?.length > 0);

  // ── Approve via the API → completed ──────────────────────────────────
  const approved = await apiCall(origin, secret, "/api/run/approve", "POST", { runId });
  check("HD-APPROVE-COMPLETES", approved.body.status === "completed", `status=${approved.body.status}`);

  // ── Reject path on a fresh run → partial ─────────────────────────────
  const started2 = await apiCall(origin, secret, "/api/run/start", "POST", { workflowId: "ic-memo" });
  const rejected = await apiCall(origin, secret, "/api/run/reject", "POST", { runId: started2.body.runId });
  check("HD-REJECT-IS-PARTIAL", rejected.body.status === "partial", `status=${rejected.body.status}`);

  // ── Unknown workflow → 400 ──────────────────────────────────────────
  const bad = await apiCall(origin, secret, "/api/run/start", "POST", { workflowId: "nope" });
  check("HD-UNKNOWN-WORKFLOW-400", bad.status === 400);

  // ── §14 ambient: /api/jobs/tick runs due jobs; list/recover the DLQ ──
  const scheduler = new DurableJobScheduler(":memory:");
  const jstart = Date.UTC(2026, 7, 3, 8, 0);
  scheduler.upsert({ jobId: "ok-job", kind: "k", schedule: { type: "interval", everyMs: 60_000 }, createdAt: jstart - 1000 });
  scheduler.upsert({ jobId: "bad-job", kind: "k", schedule: { type: "interval", everyMs: 60_000 }, maxAttempts: 2, createdAt: jstart - 1000 });
  const executed: string[] = [];
  const hdJobs = new HarnessDaemon({
    engine,
    uiDir: path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "src", "harness", "ui"),
    jobs: {
      scheduler,
      handler: async (job) => {
        executed.push(job.jobId);
        if (job.jobId === "bad-job") throw new Error("kaboom");
      },
    },
  });
  const { port: jport, origin: jorigin } = await hdJobs.listen();
  const jsecret = (hdJobs as any).opts.secret ?? (hdJobs as any).daemon.secret;
  const tick = await apiCall(jorigin, jsecret, "/api/jobs/tick", "POST");
  check("HD-JOBS-TICK-RAN", tick.body.summary?.ran >= 1, JSON.stringify(tick.body));
  check("HD-JOBS-HANDLER-RAN", executed.includes("ok-job"), JSON.stringify(executed));
  // bad-job failed once → not dead-lettered yet; a second tick on it dead-letters.
  const listOut = await apiCall(jorigin, jsecret, "/api/jobs/list");
  check("HD-JOBS-LIST-DLQ", Array.isArray(listOut.body.jobs), JSON.stringify(listOut.body));
  const rec = await apiCall(jorigin, jsecret, "/api/jobs/recover", "POST", { jobId: "bad-job" });
  check("HD-JOBS-RECOVER", rec.body.ok === "recovered");
  await hdJobs.close();

  await hd.close();
  saver.close();
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} harness-daemon check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} harness-daemon checks passed.`));