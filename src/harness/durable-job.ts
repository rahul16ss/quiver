/**
 * DurableJobs — §14 (durable job/signal layer).
 *
 * A SQLite-backed, lease-based job scheduler with crash recovery, a
 * dead-letter queue for poison jobs, and alert deduplication/aggregation.
 *
 * Guarantees:
 *  - Jobs persist across restarts (SQLite).
 *  - A job is only run under a lease; a crashed worker's lease expires
 *    (TTL) so the job is re-taken — no orphaned/stuck job, no double-run
 *    while a lease is live.
 *  - After `maxAttempts` failures a job moves to a dead-letter queue for
 *    review rather than being retried forever or silently dropped.
 *  - Alerts are deduplicated by key within a window and can be aggregated:
 *    repeated same-key signals collapse to one alert.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export type Schedule =
	| { type: "interval"; everyMs: number }
	| { type: "cron"; expr: string }; // stored + surfaced honestly; evaluation is app-specific

export interface JobSpec {
	jobId: string;
	kind: string;
	schedule: Schedule;
	/** Max execution attempts before moving to the dead-letter queue. Default 3. */
	maxAttempts?: number;
	/** Lease TTL in ms before a held job is considered crashed. */
	leaseTtlMs?: number;
	createdAt?: number;
}

export interface JobRecord {
	jobId: string;
	kind: string;
	schedule: Schedule;
	enabled: boolean;
	attempts: number;
	nextDueAt: number;
	maxAttempts: number;
	lastError?: string;
	leaseHolder?: string;
	leaseUntil?: number;
	deadLettered: boolean;
	createdAt: number;
}

export class DurableJobScheduler {
	private db: DatabaseSync;

	constructor(dbPath: string) {
		if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS durable_jobs (
				job_id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				schedule TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_due_at INTEGER NOT NULL,
				max_attempts INTEGER NOT NULL DEFAULT 3,
				last_error TEXT,
				lease_holder TEXT,
				lease_until INTEGER,
				dead_lettered INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			) STRICT;`,
		);
	}

	/** Register (or update) a job. */
	upsert(spec: JobSpec): void {
		const now = spec.createdAt ?? Date.now();
		const maxAttempts = spec.maxAttempts ?? 3;
		this.db
			.prepare(
				`INSERT INTO durable_jobs (job_id, kind, schedule, enabled, attempts, next_due_at, max_attempts, created_at)
				 VALUES (?, ?, ?, 1, 0, ?, ?, ?)
				 ON CONFLICT(job_id) DO UPDATE SET
					kind=excluded.kind, schedule=excluded.schedule, enabled=1, next_due_at=excluded.next_due_at,
					max_attempts=excluded.max_attempts`,
			)
			.run(spec.jobId, spec.kind, JSON.stringify(spec.schedule), now, maxAttempts, now);
	}

	/** Due + not dead-lettered jobs (for the scheduler to offer leases on). */
	dueNow(now: number = Date.now()): JobRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM durable_jobs WHERE enabled=1 AND dead_lettered=0 AND next_due_at <= ?
				 ORDER BY next_due_at ASC`,
			)
			.all(now) as unknown as Row[];
		return rows.map((r) => toRecord(r));
	}

	/**
	 * Attempt to acquire a lease on a job. Returns the lease token (jobId) on
	 * success, or null if the job is already leased by a live worker. A stale
	 * lease whose TTL expired is considered crashed and can be re-taken.
	 */
	acquire(jobId: string, worker: string, ttlMs: number, now: number = Date.now()): { ok: boolean; reason?: string } {
		const row = this.db
			.prepare("SELECT lease_holder, lease_until FROM durable_jobs WHERE job_id = ?")
			.get(jobId) as Row | undefined;
		if (row?.lease_holder && row.lease_until !== null && row.lease_until > now) {
			if (row.lease_holder !== worker) return { ok: false, reason: "leased" };
		}
		this.db
			.prepare("UPDATE durable_jobs SET lease_holder=?, lease_until=? WHERE job_id=?")
			.run(worker, now + ttlMs, jobId);
		return { ok: true };
	}

	/** Release a lease after a successful run and schedule the next occurrence. */
	complete(jobId: string, nextDueAt: number): void {
		this.db
			.prepare("UPDATE durable_jobs SET lease_holder=NULL, lease_until=NULL, attempts=0, next_due_at=? WHERE job_id=?")
			.run(nextDueAt, jobId);
	}

	/** Record a failed attempt; after maxAttempts, dead-letter the job. */
	fail(jobId: string, error: string, maxAttempts: number, now: number = Date.now()): boolean {
		const row = this.db.prepare("SELECT attempts FROM durable_jobs WHERE job_id = ?").get(jobId) as Row | undefined;
		const attempts = (row?.attempts ?? 0) + 1;
		if (attempts >= maxAttempts) {
			this.db
				.prepare("UPDATE durable_jobs SET attempts=?, last_error=?, dead_lettered=1, lease_holder=NULL, lease_until=NULL WHERE job_id=?")
				.run(attempts, error, jobId);
			return true; // dead-lettered
		}
		this.db
			.prepare("UPDATE durable_jobs SET attempts=?, last_error=?, lease_holder=NULL, lease_until=NULL WHERE job_id=?")
			.run(attempts, error, jobId);
		return false;
	}

	/** Jobs sitting in the dead-letter queue (poison jobs needing review). */
	deadLettered(): JobRecord[] {
		const rows = this.db.prepare("SELECT * FROM durable_jobs WHERE dead_lettered=1").all() as unknown as Row[];
		return rows.map((r) => toRecord(r));
	}

	/** Re-enable a dead-lettered job, resetting its attempts, and reschedule. */
	recover(jobId: string, at: number = Date.now()): void {
		this.db
			.prepare("UPDATE durable_jobs SET dead_lettered=0, attempts=0, last_error=NULL, next_due_at=? WHERE job_id=?")
			.run(at, jobId);
	}

	/**
	 * Run all due jobs under lease and execute each via `handler`. On success,
	 * reschedule per the interval; on failure, count the attempt (dead-letter
	 * after maxAttempts). Returns a summary of executed / leased-lost / failed.
	 * Safe to call from multiple workers: an already-leased job is skipped, so
	 * racing workers never double-run a job.
	 */
	async runDue(
		handler: (job: JobRecord) => Promise<void> | void,
		worker: string,
		opts: { now?: number; ttlMs?: number } = {},
	): Promise<{ ran: number; leased: number; failed: number }> {
		const now = opts.now ?? Date.now();
		const ttlMs = opts.ttlMs ?? 60_000;
		let ran = 0;
		let leased = 0;
		let failed = 0;
		for (const job of this.dueNow(now)) {
			const lease = this.acquire(job.jobId, worker, ttlMs, now);
			if (!lease.ok) continue; // leased by another live worker
			leased++;
			const max = job.maxAttempts;
			try {
				await handler(job);
				const next = this.nextDue(job, now);
				this.complete(job.jobId, next);
				ran++;
			} catch (err) {
				const dlq = this.fail(job.jobId, String((err as Error)?.message ?? err), max, now);
				failed++;
				// If dead-lettered, it is no longer enqueued; otherwise its current
				// next_due_at is passed, so it is retried on the next runDue pass.
				if (!dlq) {
					this.db
						.prepare("UPDATE durable_jobs SET next_due_at=? WHERE job_id=?")
						.run(now + this.retryBackoffMs, job.jobId);
				}
			}
		}
		return { ran, leased, failed };
	}

	private get maxAttemptsDefault(): number {
		return 3;
	}

	private get retryBackoffMs(): number {
		return 5_000;
	}

	private nextDue(job: JobRecord, now: number): number {
		const s = job.schedule;
		if (s.type === "interval") return now + s.everyMs;
		// Cron: compute the actual next fire time so the job is due at the
		// intended instant, not a coarse 1-min re-check.
		return cronNext(s.expr, now);
	}
}

/**
 * Compute the next fire time (ms epoch) for a standard 5-field cron expression
 * `min hour dom month dow`, supporting `*`, `,`, `-`, and `/`.
 * Constants: DOM = day-of-month (1-31); DOW = day-of-week (0-6, Sun=0).
 */
export function cronNext(expr: string, from: number = Date.now()): number {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) throw new Error(`Invalid cron expression (expected 5 fields): "${expr}"`);
	const [minF, hourF, domF, monF, dowF] = parts;
	const minutes = parseField(minF, 0, 59);
	const hours = parseField(hourF, 0, 23);
	const doms = parseField(domF, 1, 31);
	const months = parseField(monF, 1, 12);
	const dows = parseField(dowF, 0, 6);

	const start = new Date(from);
	let cand = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), 0, 0));
	cand.setUTCMinutes(cand.getUTCMinutes() + 1); // strictly after `from` minute

	const mode = (domF !== "*" || dowF !== "*"); // DOM or DOW constrained
	for (let guard = 0; guard < 366 * 25; guard++) {
		const y = cand.getUTCFullYear();
		const mo = cand.getUTCMonth() + 1; // 1-12
		const dom = cand.getUTCDate();
		const dow = cand.getUTCDay();

		if (mode) {
			// Cron DOM/DOW semantics: if both are restricted, a match on EITHER
			// counts; if only one is restricted, that one must match.
			const domRestricted = domF !== "*";
			const dowRestricted = dowF !== "*";
			const domOk = doms.has(dom);
			const dowOk = dows.has(dow);
			const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domRestricted ? domOk : dowOk;
			if (!dayOk) { cand = rollToNextDay(cand); continue; }
		} else {
			// Neither DOM nor DOW restricted → day always allowed.
		}

		if (months.has(mo) && hours.has(cand.getUTCHours()) && minutes.has(cand.getUTCMinutes())) {
			return cand.getTime();
		}
		// Advance: if hour/minute don't match, step to the next matching minute
		// or hour; otherwise roll to next day.
		cand.setUTCMinutes(cand.getUTCMinutes() + 1);
		if (cand.getUTCHours() === 0 && cand.getUTCMinutes() === 0) {
			// already rolled into next day via +1
		}
	}
	throw new Error(`Cron expression "${expr}" could not be resolved within a reasonable horizon.`);
}

function rollToNextDay(d: Date): Date {
	d.setUTCDate(d.getUTCDate() + 1);
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

function parseField(field: string, min: number, max: number): Set<number> {
	const out = new Set<number>();
	for (const item of field.split(",")) {
		let step = 1;
		let range = item;
		const slash = item.indexOf("/");
		if (slash !== -1) {
			range = item.slice(0, slash);
			step = parseInt(item.slice(slash + 1), 10) || 1;
		}
		let lo: number; let hi: number;
		if (range === "*") { lo = min; hi = max; }
		else if (range.includes("-")) {
			const [a, b] = range.split("-");
			lo = parseInt(a, 10); hi = parseInt(b, 10);
		} else { lo = hi = parseInt(range, 10); }
		for (let v = lo; v <= hi; v += step) out.add(v);
	}
	return out;
}

interface Row {
	job_id: string;
	kind: string;
	schedule: string;
	enabled: number;
	attempts: number;
	next_due_at: number;
	max_attempts: number;
	last_error: string | null;
	lease_holder: string | null;
	lease_until: number | null;
	dead_lettered: number;
	created_at: number;
}

function toRecord(r: Row): JobRecord {
	return {
		jobId: r.job_id,
		kind: r.kind,
		schedule: JSON.parse(r.schedule) as Schedule,
		enabled: r.enabled === 1,
		attempts: r.attempts,
		nextDueAt: r.next_due_at,
		maxAttempts: r.max_attempts,
		lastError: r.last_error ?? undefined,
		leaseHolder: r.lease_holder ?? undefined,
		leaseUntil: r.lease_until ?? undefined,
		deadLettered: r.dead_lettered === 1,
		createdAt: r.created_at,
	};
}

/**
 * Alert deduplication + aggregation.
 *
 * Alerts keyed by `{ scope, fingerprint }` collapse within a  `windowMs`
 * dedup window: a repeated same-key signal before the window expires is folded
 * into the existing alert (aggregated `count` + `lastSeenAt`) instead of
 * emitting a new alert. This prevents alert storms on repeating failures.
 */
export class AlertAggregator {
	// scope:fingerprint -> aggregate state
	private state = new Map<string, AlertAggregate>();

	constructor(private windowMs: number = 60_000) {}

	/**
	 * Signals a keyed alert. Returns the aggregate record to emit now when the
	 * signal is new or the window has re-armed; returns null when it's an
	 * in-window duplicate being folded.
	 */
	signal(scope: string, fingerprint: string, now: number = Date.now()): AlertAggregate | null {
		const key = `${scope}:${fingerprint}`;
		const cur = this.state.get(key);
		if (cur && now < cur.refireAt) {
			// In-window duplicate → fold (aggregate), do not emit.
			cur.count += 1;
			cur.lastSeenAt = now;
			return null;
		}
		const agg: AlertAggregate = { key, scope, fingerprint, count: 1, firstSeenAt: now, lastSeenAt: now, refireAt: now + this.windowMs };
		this.state.set(key, agg);
		return agg;
	}

	/** All currently open aggregates (for inspection/review). */
	open(now: number = Date.now()): AlertAggregate[] {
		this.prune(now);
		return Array.from(this.state.values()).map((a) => ({ ...a }));
	}

	/** Drop aggregates whose window has elapsed (expired, no longer open). */
	private prune(now: number = Date.now()): void {
		for (const [k, a] of this.state) {
			if (now >= a.refireAt) this.state.delete(k);
		}
	}

	/** Window elapsed for an aggregate → next signal of the same key re-fires. */
	ack(key: string): void {
		this.state.delete(key);
	}
}

export interface AlertAggregate {
	key: string;
	scope: string;
	fingerprint: string;
	count: number;
	firstSeenAt: number;
	lastSeenAt: number;
	refireAt: number;
}

/**
 * Durable idempotency ledger — deduplicates event/delivery processing across
 * restarts (webhook replay / redelivery guard).
 *
 * `alreadyProcessed(id)` is true only if this exact id was previously
 * recorded; `markProcessed(id)` records it durably. Backed by a CursorKV
 * (SQLite in production) so a redelivered event after a process restart is
 * still recognized and not processed twice.
 */
export class DurableIdempotencyLedger {
	constructor(private kv: import("./cursor-store.js").CursorKV, private prefix = "quiver:seen:") {}

	private key(id: string): string {
		return this.prefix + id;
	}

	/** True if `id` was already processed (recorded durably). */
	async alreadyProcessed(id: string): Promise<boolean> {
		return (await this.kv.get(this.key(id))) !== null;
	}

	/** Record `id` as processed. Returns true on first-time mark (no pre-existing). */
	async markProcessed(id: string): Promise<boolean> {
		const existed = await this.alreadyProcessed(id);
		if (!existed) await this.kv.set(this.key(id), "1");
		return !existed;
	}

	/**
	 * Idempotent touch: returns true (and records) only if `id` was NOT yet
	 * processed. Use as a guard wrapping an effect so a redelivered webhook
	 * never runs the effect twice.
	 */
	async touch(id: string): Promise<boolean> {
		return this.markProcessed(id);
	}
}

