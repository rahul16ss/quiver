/**
 * GraphOAuthClient behavioral tests (§10 Entra OAuth).
 *
 * Proves the concrete Graph client actually CONSUMES the keychain-backed
 * ConnectorTokenManager: it attaches the stored access token, refreshes from
 * the stored refresh token on 401 and retries once (persisting the new token),
 * mints an access token from a refresh-only state, and fails clearly when no
 * credential exists. Deterministic (mock transport + in-memory token store);
 * no network, no real keychain.
 */
import picocolors from "picocolors";
import { GraphOAuthClient, type GraphTransport } from "../../src/harness/graph-oauth-client.js";
import { ConnectorTokenManager, InMemoryTokenStore } from "../../src/harness/connector-tokens.js";
import type { GraphItemMetadata } from "../../src/harness/storage-providers.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
	else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

/** A mock transport recording the bearer tokens it saw and scripted statuses. */
function mockTransport(script: { firstStatus?: number; refreshTo?: string } = {}): GraphTransport & { seen: string[]; refreshes: number } {
	const seen: string[] = [];
	let calls = 0;
	const t: any = {
		seen,
		refreshes: 0,
		async get(_path: string, { accessToken }: { accessToken: string }) {
			seen.push(accessToken);
			calls++;
			// First call may be scripted to 401 (expired/invalid token).
			const status = calls === 1 ? (script.firstStatus ?? 200) : 200;
			return { status, body: { name: "memo.docx", eTag: "e1", webUrl: "https://graph/x", size: 12, lastModifiedDateTime: "2026-08-06T00:00:00Z", value: [] } };
		},
		async head() { return { status: 200, headers: {} }; },
		async put() { return { status: 200, body: {} as GraphItemMetadata }; },
		async refresh(_rt: string) {
			t.refreshes++;
			return { accessToken: script.refreshTo ?? "acc-refreshed", refreshToken: "ref-rotated", expiresIn: 3600 };
		},
	};
	return t;
}

const AUTH = { tenantId: "tenant-1", clientId: "client-1", connector: "sharepoint" };

async function run() {
	// ── Stored access token is attached to the request ──────────────────
	const store1 = new InMemoryTokenStore();
	const tm1 = new ConnectorTokenManager("sharepoint", store1);
	await tm1.persist({ accessToken: "acc-live", refreshToken: "ref-1", expiresAt: Date.now() + 3600_000 });
	const tr1 = mockTransport();
	const c1 = new GraphOAuthClient({ ...AUTH, tokenManager: tm1 }, tr1);
	const md = await c1.getMetadata("item-1");
	check("USES-STORED-ACCESS-TOKEN", tr1.seen[0] === "acc-live", JSON.stringify(tr1.seen));
	check("METADATA-NORMALIZED", md.id === "item-1" && md.name === "memo.docx" && md.eTag === "e1", JSON.stringify(md));
	check("NO-REFRESH-WHEN-VALID", tr1.refreshes === 0);

	// ── 401 → refresh from the stored refresh token, retry once ─────────
	const store2 = new InMemoryTokenStore();
	const tm2 = new ConnectorTokenManager("sharepoint", store2);
	await tm2.persist({ accessToken: "acc-stale", refreshToken: "ref-2", expiresAt: Date.now() + 3600_000 });
	const tr2 = mockTransport({ firstStatus: 401, refreshTo: "acc-after-401" });
	const c2 = new GraphOAuthClient({ ...AUTH, tokenManager: tm2 }, tr2);
	const md2 = await c2.getMetadata("item-2");
	check("REFRESHED-ON-401", tr2.refreshes === 1, `refreshes=${tr2.refreshes}`);
	check("RETRIED-WITH-NEW-TOKEN", tr2.seen[1] === "acc-after-401", JSON.stringify(tr2.seen));
	check("RETRY-SUCCEEDS", md2.id === "item-2");
	// The refreshed token (and rotated refresh token) are persisted.
	const after = await tm2.load();
	check("NEW-ACCESS-PERSISTED", after.accessToken === "acc-after-401", JSON.stringify(after));
	check("ROTATED-REFRESH-PERSISTED", after.refreshToken === "ref-rotated");

	// ── Refresh-only state mints an access token before the call ────────
	const store3 = new InMemoryTokenStore();
	const tm3 = new ConnectorTokenManager("sharepoint", store3);
	await tm3.persist({ refreshToken: "ref-only" }); // no access token
	const tr3 = mockTransport({ refreshTo: "acc-minted" });
	const c3 = new GraphOAuthClient({ ...AUTH, tokenManager: tm3 }, tr3);
	await c3.getMetadata("item-3");
	check("MINTS-FROM-REFRESH-ONLY", tr3.refreshes === 1 && tr3.seen[0] === "acc-minted", JSON.stringify({ r: tr3.refreshes, seen: tr3.seen }));

	// ── No credential at all → clear auth failure (never a silent success) ──
	const tm4 = new ConnectorTokenManager("sharepoint", new InMemoryTokenStore());
	const c4 = new GraphOAuthClient({ ...AUTH, tokenManager: tm4 }, mockTransport());
	let authErr = "";
	try { await c4.getMetadata("item-4"); } catch (e: any) { authErr = String(e.message); }
	check("NO-CREDENTIAL-FAILS-CLEARLY", /no access or refresh token/i.test(authErr), authErr);

	// ── Expired access + refresh present → mints, does not use stale ────
	const store5 = new InMemoryTokenStore();
	const tm5 = new ConnectorTokenManager("sharepoint", store5);
	await tm5.persist({ accessToken: "acc-expired", refreshToken: "ref-5", expiresAt: Date.now() - 1 });
	const tr5 = mockTransport({ refreshTo: "acc-fresh" });
	const c5 = new GraphOAuthClient({ ...AUTH, tokenManager: tm5 }, tr5);
	await c5.getMetadata("item-5");
	check("EXPIRED-NOT-SENT", !tr5.seen.includes("acc-expired"), JSON.stringify(tr5.seen));
	check("EXPIRED-MINTS-FRESH", tr5.seen[0] === "acc-fresh", JSON.stringify(tr5.seen));
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} graph-oauth check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} graph-oauth checks passed.`));
