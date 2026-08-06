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
		this.db
			.prepare(
				`INSERT INTO durable_jobs (job_id, kind, schedule, enabled, attempts, next_due_at, created_at)
				 VALUES (?, ?, ?, 1, 0, ?, ?)
				 ON CONFLICT(job_id) DO UPDATE SET
					kind=excluded.kind, schedule=excluded.schedule, enabled=1, next_due_at=excluded.next_due_at`,
			)
			.run(spec.jobId, spec.kind, JSON.stringify(spec.schedule), now, now);
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
}

interface Row {
	job_id: string;
	kind: string;
	schedule: string;
	enabled: number;
	attempts: number;
	next_due_at: number;
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
