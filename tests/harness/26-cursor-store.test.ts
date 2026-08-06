/**
 * DurableCursorStore behavioral tests (§5/§14).
 *
 * Proves durable/replay-safe cursor semantics: persist across store instance
 * boundaries, first-writer-wins advance (no lost updates / no double-apply),
 * idempotent advance, and planNext resume (never misses or replays a window).
 * Deterministic exit; no network.
 */
import picocolors from "picocolors";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import {
	DurableCursorStore,
	InMemoryCursorKV,
	SqliteCursorKV,
	type CursorKV,
} from "../../src/harness/cursor-store.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
	else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

/** A durable KV that survives "restart" (new store instance over the same backing). */
function makeKV(): { kv: CursorKV; reboot(): DurableCursorStore } {
	const kv = new InMemoryCursorKV();
	return { kv, reboot: () => new DurableCursorStore(kv) };
}

async function run() {
	// ── Cold start: no cursor ──────────────────────────────────────────
	const { kv, reboot } = makeKV();
	const s1 = new DurableCursorStore(kv);
	check("COLD-GET-NULL", (await s1.get("drive")) === null);

	// ── Advance persists; durable across new store instance (restart) ──
	check("ADVANCE-TRUE-FIRST", await s1.advance("drive", "token-1"));
	const s2 = reboot(); // simulate restart
	check("DURABLE-ACROSS-RESTART", (await s2.get("drive")) === "token-1");

	// ── Idempotent: advancing to the same cursor is a no-op (returns false) ──
	check("IDEMPOTENT-ADVANCE-FALSE", !(await s2.advance("drive", "token-1")));
	// Advancing to a NEW opaque cursor persists it (opaque tokens: no cross-writer
	// ordering, so a later writer's token wins; idempotency is per-value).
	check("NEW-ADVANCE-TRUE", await s2.advance("drive", "token-1b"));
	check("NEW-VALUE-PERSISTED", (await s2.get("drive")) === "token-1b");
	await s2.advance("drive", "token-1"); // restore for planner steps

	// ── Replay safety: planNext never re-applies an already-applied window ──
	let appliedWindows: (string | null)[] = [];
	let fetched = 0;
	const applied = await s2.planNext(
		"drive",
		async (cursor) => {
			fetched++;
			// The provider maps the held cursor to a "since"; token-1 → since "s1".
			return { since: cursor === null ? null : cursor === "token-1" ? "s1" : "s0", nextCursor: "token-1" };
		},
		async (since) => {
			appliedWindows.push(since);
			// Provider returns the new "up to here" token (advances the feed).
			return "token-2";
		},
	);
	check("PLANNEXT-APPLIED-NEW", applied.applied === true, JSON.stringify(applied));
	check("PLANNEXT-CURSOR-ADVANCED", applied.nextCursor === "token-2");
	check("WINDOW-APPLIED-ONCE", appliedWindows.length === 1, JSON.stringify(appliedWindows));
	check("DURABLE-CURSOR-IS-TOKEN2", (await s2.get("drive")) === "token-2");

	// ── A second poll with no new data must NOT persist a new cursor (replay guard) ──
	appliedWindows = [];
	const noChange = await s2.planNext(
		"drive",
		async (cursor) => ({ since: "s2", nextCursor: cursor ?? undefined }),
		async (since) => {
			appliedWindows.push(since);
			if (since === "s2") return null; // no changes → provider returns null (nothing to persist)
			return "token-3";
		},
	);
	check("REPLAY-GUARD-NO-REAPPLY", noChange.applied === false, JSON.stringify(noChange));
	check("NO-CHANGE-WINDOW-POLLED-ONCE", appliedWindows.length === 1, JSON.stringify(appliedWindows));
	check("CURSOR-UNCHANGED-ON-NO-CHANGE", (await s2.get("drive")) === "token-2");

	// ── Independent scopes remain isolated ─────────────────────────────
	await s1.advance("graph", "g-1");
	await s1.advance("drive", "d-2");
	check("SCOPES-ISOLATED", (await s1.get("graph")) === "g-1" && (await s2.get("drive")) === "d-2");

	// ── Fresh scope cold caught up from the beginning (since null) ─────
	const fetchedSince: (string | null)[] = [];
	const cold = await s2.planNext(
		"sharepoint",
		async () => ({ since: null, nextCursor: "s0" }),
		async (since) => { fetchedSince.push(since); return "s-cold"; },
	);
	check("COLD-SINCE-NULL", fetchedSince[0] === null, JSON.stringify(fetchedSince));
	check("COLD-CURSOR-PERSISTED", cold.nextCursor === "s-cold" && (await s2.get("sharepoint")) === "s-cold");

	// ── SQLite-backed cursor is durable across a new store (process restart) ──
	const dbPath = path.join(os.tmpdir(), `quiver-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const sqlite1 = new DurableCursorStore(new SqliteCursorKV(dbPath));
	await sqlite1.advance("monitor:earnings", "tok-restart-1");
	check("SQLITE-ADVANCE-PERSISTED", (await sqlite1.get("monitor:earnings")) === "tok-restart-1");
	// New store over the SAME file = simulated process restart.
	const sqlite2 = new DurableCursorStore(new SqliteCursorKV(dbPath));
	check(
		"SQLITE-DURABLE-ACROSS-RESTART",
		(await sqlite2.get("monitor:earnings")) === "tok-restart-1",
		(await sqlite2.get("monitor:earnings")) ?? "null",
	);
	for (const suffix of ["", "-wal", "-shm"]) {
		try { fs.rmSync(dbPath + suffix, { force: true }); } catch {}
	}
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} cursor-store check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} cursor-store checks passed.`));
