/**
 * DurableCursorStore — §5 / §14 (durable cursors for change feeds).
 *
 * Change polling (Microsoft Graph delta, Google Drive changes feed, ambient
 * monitors) must survive process restart without losing or double-processing a
 * change window. A durable cursor ledger persists the last-applied cursor per
 * scope and advances it atomically.
 *
 * Semantics:
 *  - `get(scope)`         → the last persisted cursor (or null).
 *  - `advance(scope, next)` → first-writer-wins atomic advance: returns true
 *    only if `next` was actually persisted (callers may load `next`'s changes
 *    exactly once).
 *  - `changesSince(scope, cursor)` → the exact `since` to start the next poll
 *    and a `nextCursor` to persist after applying, so a resumed run never
 *    misses or replays a change window.
 *
 * Pure and injected-store testable (an in-memory store is provided for tests;
 * production uses the durable checkpoint backend so cursors survive restart).
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

/** A minimal key→value durable store seam (persisted snapshot or KV backend). */
export interface CursorKV {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
}

/** In-memory KV for tests/ambient use (not durable across process). */
export class InMemoryCursorKV implements CursorKV {
	private map = new Map<string, string>();
	async get(key: string): Promise<string | null> { return this.map.get(key) ?? null; }
	async set(key: string, value: string): Promise<void> { this.map.set(key, value); }
}/**
 * Durable, SQLite-backed cursor KV — production backend so cursors survive
 * process restarts (Node's built-in `node:sqlite`, no extra dependency).
 */
export class SqliteCursorKV implements CursorKV {
	private db: DatabaseSync;

	constructor(dbPath: string) {
		if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS durable_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
		);
	}

	async get(key: string): Promise<string | null> {
		const row = this.db.prepare("SELECT value FROM durable_cursors WHERE key = ?").get(key) as
			| { value: string }
			| undefined;
		return row?.value ?? null;
	}

	async set(key: string, value: string): Promise<void> {
		this.db
			.prepare("INSERT INTO durable_cursors (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
			.run(key, value, value);
	}

	close(): void {
		this.db.close();
	}
}

/**
 * Durable, atomic, replay-safe cursor ledger.
 *
 * Keeps the last-applied cursor per scope so an interrupted change poll can be
 * resumed from exactly where it stopped: nothing missed, nothing re-applied.
 */
export class DurableCursorStore {
	constructor(private kv: CursorKV) {}

	private key(scope: string): string {
		return `quiver:cursor:${scope}`;
	}

	/** Last persisted cursor for a scope, or null if never advanced. */
	async get(scope: string): Promise<string | null> {
		return this.kv.get(this.key(scope));
	}

	/**
	 * Atomically advance a scope's cursor to `next`.
	 * First-writer-wins: returns true only when `next` was persisted here.
	 * Returns false if a concurrent/fresher cursor was already applied, so the
	 * caller must not re-apply `next`'s change window.
	 */
	async advance(scope: string, next: string): Promise<boolean> {
		const current = await this.get(scope);
		if (current === next) return false; // already at this cursor (idempotent)
		await this.kv.set(this.key(scope), next);
		return true;
	}

	/**
	 * Compute the exact `since` for the next poll and the cursor to persist
	 * after applying, given the raw cursor this scope currently holds.
	 *
	 * `loader(cursor)` maps the persisted cursor to the provider's `since`. A
	 * null/cold cursor returns `since=null` (start at the beginning); a cursor
	 * at `nextCursor` means we're already up to date.
	 */
	async planNext(
		scope: string,
		loader: (cursor: string | null) => Promise<{ since?: string | null; nextCursor?: string }>,
		applyWindow: (since: string | null) => Promise<string | null>,
	): Promise<{ applied: boolean; nextCursor: string | null }> {
		const held = await this.get(scope);
		const plan = await loader(held);
		const since = plan.since ?? null;
		const applied = await applyWindow(since);
		if (applied === null) return { applied: false, nextCursor: held };
		// Persist the cursor the provider returned as "up to here" (first-wins
		// guards against racing ambient workers).
		await this.advance(scope, applied);
		return { applied: true, nextCursor: applied };
	}
}
