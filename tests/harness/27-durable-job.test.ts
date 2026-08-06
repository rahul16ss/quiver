/**
 * DurableJob behavioral tests (§14).
 *
 * Proves lease-based scheduling with crash recovery (expired lease re-taken),
 * dead-letter queueing for poison jobs, and alert dedup/aggregation.
 * Deterministic exit; SQLite-backed (durable) + in-memory (job + alerts).
 */
import picocolors from "picocolors";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { DurableJobScheduler, AlertAggregator } from "../../src/harness/durable-job.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
	else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {	// ── Interval due scheduling ─────────────────────────────────────────
	const s = new DurableJobScheduler(":memory:");
	s.upsert({ jobId: "j1", kind: "earnings-monitor", schedule: { type: "interval", everyMs: 60_000 } });
	check("JOB-PERSISTED-DUE", s.dueNow(Date.now()).some((j) => j.jobId === "j1"));

	// ── Lease acquire + live-lease blocks a second worker ──────────────
	const a1 = s.acquire("j1", "worker-a", 30_000, 1000);
	check("LEASE-ACQUIRED", a1.ok === true, JSON.stringify(a1));
	const a2 = s.acquire("j1", "worker-b", 30_000, 2000);
	check("LEASE-BLOCKS-SECOND-WORKER", a2.ok === false && a2.reason === "leased", JSON.stringify(a2));

	// ── Crash recovery: worker-b's TTL expired → lease re-takable ──────
	// Simulate worker-a crashing (its lease expires after 30s). worker-b
	// (or a new worker) may now acquire after the TTL.
	const a3 = s.acquire("j1", "worker-b", 30_000, 40_000); // now > worker-a lease_until (1000+30000)
	check("LEASE-RETAKEN-AFTER-TTL", a3.ok === true, JSON.stringify(a3));

	// ── Complete releases the lease and reschedules ────────────────────
	s.complete("j1", Date.now() + 60_000);
	check("COMPLETE-CLEARS-LEASE", s.acquire("j1", "worker-a", 30_000).ok === true);
	check("COMPLETE-RESCHEDULES", !s.dueNow(Date.now()).some((j) => j.jobId === "j1")); // not due yet

	// ── Poison job → dead-letter after maxAttempts; not due forever ────
	const s2 = new DurableJobScheduler(":memory:");
	s2.upsert({ jobId: "poison", kind: "bad", schedule: { type: "interval", everyMs: 1_000 }, maxAttempts: 3, createdAt: 0 });
	s2.acquire("poison", "w", 30_000, 10);
	s2.fail("poison", "boom", 3, 10);
	check("NOT-DLQ-AFTER-1", s2.deadLettered().length === 0);
	s2.acquire("poison", "w", 30_000, 20);
	s2.fail("poison", "boom2", 3, 20);
	check("NOT-DLQ-AFTER-2", s2.deadLettered().length === 0);
	s2.acquire("poison", "w", 30_000, 30);
	const dlqed = s2.fail("poison", "boom3", 3, 30);
	check("DLQ-AFTER-MAXATTEMPTS", dlqed === true && s2.deadLettered().length === 1, JSON.stringify(s2.deadLettered()));
	check("DLQ-JOB-NOT-ENQUEUED", s2.dueNow(100_000).every((j) => j.jobId !== "poison"));

	// ── Recover a dead-lettered job ────────────────────────────────────
	s2.recover("poison", 5_000);
	check("RECOVER-REENABLES", s2.dueNow(6_000).some((j) => j.jobId === "poison") && s2.deadLettered().length === 0);

	// ── runDue: leases + executes due jobs, reschedules on success ─────
	const s3 = new DurableJobScheduler(":memory:");
	s3.upsert({ jobId: "a", kind: "k", schedule: { type: "interval", everyMs: 10_000 }, createdAt: 0 });
	s3.upsert({ jobId: "b", kind: "k", schedule: { type: "interval", everyMs: 10_000 }, createdAt: 0 });
	const executed: string[] = [];
	const r1 = await s3.runDue(async (j) => { executed.push(j.jobId); }, "w", { now: 0 });
	check("RUNDUE-EXECUTES-ALL", r1.ran === 2 && executed.length === 2, JSON.stringify({ r1, executed }));
	check("RUNDUE-RESCHEDULES", s3.dueNow(0).length === 0); // now due again only after interval
	check("RUNDUE-NOT-DUE-AT-5K", s3.dueNow(5_000).length === 0);
	check("RUNDUE-DUE-AFTER-INTERVAL", s3.dueNow(10_000 + 1).length === 2);

	// ── runDue: a racing worker's already-leased job is skipped ─────────
	// Worker-w holds a live lease on a new job; worker-2 must not run it.
	s3.upsert({ jobId: "c", kind: "k", schedule: { type: "interval", everyMs: 10_000 }, createdAt: 0 });
	s3.acquire("c", "worker-w", 60_000, 10); // live lease within TTL
	const raced = await s3.runDue(async () => {}, "worker-2", { now: 20, ttlMs: 60_000 });
	check("RUNDUE-RACING-SKIPPED", raced.ran === 0 && raced.leased === 0, JSON.stringify(raced));

	// ── runDue: a throwing handler is counted, then dead-letters ────────
	const s4 = new DurableJobScheduler(":memory:");
	s4.upsert({ jobId: "p", kind: "bad", schedule: { type: "interval", everyMs: 10_000 }, createdAt: 0, maxAttempts: 2 });
	const f1 = await s4.runDue(async () => { throw new Error("kaboom"); }, "w", { now: 0, ttlMs: 30_000 });
	check("RUNDUE-FAILED-COUNTS", f1.failed === 1, JSON.stringify(f1));
	check("RUNDUE-FAILED-NOT-DLQ-YET", s4.deadLettered().length === 0);
	const f2 = await s4.runDue(async () => { throw new Error("kaboom2"); }, "w", { now: 5_000, ttlMs: 30_000 });
	check("RUNDUE-DLQ-AFTER-MAXATTEMPTS", f2.failed === 1 && s4.deadLettered().length === 1, JSON.stringify({ f2, dlq: s4.deadLettered() }));

	// ── SQLite durability: jobs survive a new scheduler instance ───────
	const dbPath = path.join(os.tmpdir(), `quiver-jobs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const d1 = new DurableJobScheduler(dbPath);
	d1.upsert({ jobId: "durable", kind: "k", schedule: { type: "interval", everyMs: 1_000 }, maxAttempts: 2, createdAt: 0 });
	d1.acquire("durable", "w", 30_000, 10);
	d1.fail("durable", "boom", 2, 10); // attempt 1/2
	d1.acquire("durable", "w", 30_000, 20);
	const dlqA = d1.fail("durable", "boom2", 2, 20); // attempt 2/2 → dead-lettered
	check("SQLITE-JOB-DURABLE-FIRST", dlqA === true && d1.deadLettered().length === 1, JSON.stringify(d1.deadLettered()));
	const d2 = new DurableJobScheduler(dbPath); // restart
	check("SQLITE-DLQ-DURABLE-ACROSS-RESTART", d2.deadLettered().length === 1, JSON.stringify(d2.deadLettered()));
	for (const suffix of ["", "-wal", "-shm"]) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch {} }

	// ── Alert dedup + aggregation ───────────────────────────────────────
	const agg = new AlertAggregator(60_000);
	const first = agg.signal("monitor", "us-gdp-down", 1000);
	check("ALERT-FIRST-EMITS", first !== null && first.count === 1 && first.fingerprint === "us-gdp-down", JSON.stringify(first));
	check("ALERT-FOLD-IN-WINDOW", agg.signal("monitor", "us-gdp-down", 2000) === null);
	// Inspect with a deterministic clock inside the window (45000 ≤ refire 61000).
	check("ALERT-AGGREGATE-COUNT", agg.open(45_000).find((a) => a.fingerprint === "us-gdp-down")?.count === 2, JSON.stringify(agg.open(45_000)));
	// After the window elapses, a new signal re-fires.
	const refire = agg.signal("monitor", "us-gdp-down", 1000 + 60_000 + 1);
	check("ALERT-REFIRES-AFTER-WINDOW", refire !== null && refire.count === 1, JSON.stringify(refire));
	// Different fingerprints/scopes do not collapse.
	agg.signal("monitor", "other", 1500);
	check("ALERT-SCOPED-INDEPENDENT", agg.open(45_000).filter((a) => a.scope === "monitor").length >= 2, JSON.stringify(agg.open(45_000).map((a) => a.fingerprint)));
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} durable-job check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} durable-job checks passed.`));
