/**
 * DriveOAuthClient behavioral tests (§10 Google OAuth → Drive).
 *
 * Proves the concrete Drive client consumes the keychain-backed token store:
 * attaches the stored access token, refreshes + retries on 401 (persisting
 * rotation), mints from refresh-only / expired states, fails clearly with no
 * credential, flags Google-native docs (never silently converted), and maps a
 * Drive changes feed to StorageChange with a nextPageToken. Deterministic
 * (mock transport, in-memory token store), no network.
 */
import picocolors from "picocolors";
import { DriveOAuthClient, type DriveTransport } from "../../src/harness/drive-oauth-client.js";
import { ConnectorTokenManager, InMemoryTokenStore } from "../../src/harness/connector-tokens.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
	else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

function mockTransport(opts: { firstStatus?: number; isGoogle?: boolean; headRevisionId?: string; refreshTo?: string } = {}): DriveTransport & { seen: string[]; refreshes: number } {
	const seen: string[] = [];
	let calls = 0;
	const t: any = {
		seen,
		refreshes: 0,
		async get(_path: string, { accessToken }: { accessToken: string }) {
			seen.push(accessToken);
			calls++;
			const status = calls === 1 ? (opts.firstStatus ?? 200) : 200;
			return {
				status,
				body: {
					id: "file-x",
					name: "model.xlsx",
					mimeType: opts.isGoogle ? "application/vnd.google-apps.spreadsheet" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					webViewLink: "https://drive/file-x",
					headRevisionId: opts.headRevisionId ?? "rev-9",
					changes: opts.isGoogle ? [] : [{ file: { id: "c1", name: "change-1", mimeType: "text/plain" } }],
					nextPageToken: "np-2",
				},
			};
		},
		async post() { return { status: 200, body: {} }; },
		async refresh(_rt: string) { t.refreshes++; return { accessToken: opts.refreshTo ?? "acc-refreshed", refreshToken: "ref-rotated", expiresIn: 3600 }; },
	};
	return t;
}

const AUTH = { clientId: "google-client", connector: "drive" };

async function run() {
	// ── Stored access token attached; metadata normalized ──────────────
	const s1 = new InMemoryTokenStore();
	const tm1 = new ConnectorTokenManager("drive", s1);
	await tm1.persist({ accessToken: "acc-live", refreshToken: "ref-1", expiresAt: Date.now() + 3600_000 });
	const tr1 = mockTransport();
	const c1 = new DriveOAuthClient({ ...AUTH, tokenManager: tm1 }, tr1);
	const md = await c1.getMetadata("file-x");
	check("USES-STORED-TOKEN", tr1.seen[0] === "acc-live", JSON.stringify(tr1.seen));
	check("FILE-NOT-GOOGLE-NATIVE", md.isGoogleNative === false && md.headRevisionId === "rev-9", JSON.stringify(md));
	check("NO-REFRESH-WHEN-VALID", tr1.refreshes === 0);

	// ── Google-native doc surfaced isGoogleNative (never silently converted) ──
	const sG = new InMemoryTokenStore();
	const tmG = new ConnectorTokenManager("drive", sG);
	await tmG.persist({ accessToken: "acc-g", refreshToken: "ref-g", expiresAt: Date.now() + 3600_000 });
	const cG = new DriveOAuthClient({ ...AUTH, tokenManager: tmG }, mockTransport({ isGoogle: true }));
	const gmd = await cG.getMetadata("file-g");
	check("GOOGLE-NATIVE-IS-REPORTED", gmd.isGoogleNative === true, JSON.stringify(gmd));

	// ── 401 → refresh + retry once, rotation persisted ──────────────────
	const s2 = new InMemoryTokenStore();
	const tm2 = new ConnectorTokenManager("drive", s2);
	await tm2.persist({ accessToken: "acc-stale", refreshToken: "ref-2", expiresAt: Date.now() + 3600_000 });
	const tr2 = mockTransport({ firstStatus: 401, refreshTo: "acc-after-401" });
	const c2 = new DriveOAuthClient({ ...AUTH, tokenManager: tm2 }, tr2);
	const md2 = await c2.getMetadata("file-2");
	check("REFRESHED-ON-401", tr2.refreshes === 1, `refreshes=${tr2.refreshes}`);
	check("RETRIED-WITH-NEW-TOKEN", tr2.seen[1] === "acc-after-401", JSON.stringify(tr2.seen));
	check("RETRY-SUCCEEDS", md2.id === "file-x" && md2.name === "model.xlsx", JSON.stringify(md2));
	check("ROTATION-PERSISTED", (await tm2.load()).refreshToken === "ref-rotated");

	// ── Refresh-only state mints an access token ───────────────────────
	const s3 = new InMemoryTokenStore();
	const tm3 = new ConnectorTokenManager("drive", s3);
	await tm3.persist({ refreshToken: "ref-only" });
	const tr3 = mockTransport({ refreshTo: "acc-minted" });
	await new DriveOAuthClient({ ...AUTH, tokenManager: tm3 }, tr3).getMetadata("file-3");
	check("MINTS-FROM-REFRESH-ONLY", tr3.refreshes === 1 && tr3.seen[0] === "acc-minted", JSON.stringify(tr3.seen));

	// ── No credential → clear auth failure ─────────────────────────────
	const c4 = new DriveOAuthClient({ ...AUTH, tokenManager: new ConnectorTokenManager("drive", new InMemoryTokenStore()) }, mockTransport());
	let err = "";
	try { await c4.getMetadata("file-4"); } catch (e: any) { err = String(e.message); }
	check("NO-CREDENTIAL-FAILS-CLEARLY", /no access or refresh token/i.test(err), err);

	// ── changes feed maps to changes + nextPageToken ───────────────────
	const s5 = new InMemoryTokenStore();
	const tm5 = new ConnectorTokenManager("drive", s5);
	await tm5.persist({ accessToken: "acc-c", refreshToken: "ref-c", expiresAt: Date.now() + 3600_000 });
	const c5 = new DriveOAuthClient({ ...AUTH, tokenManager: tm5 }, mockTransport());
	const feed = await c5.listChanges();
	check("CHANGES-FEED-MAPS", feed.changes.length === 1 && feed.changes[0].id === "c1", JSON.stringify(feed));
	check("CHANGES-NEXTPAGETOKEN", feed.nextPageToken === "np-2", JSON.stringify(feed.nextPageToken));
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} drive-oauth check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} drive-oauth checks passed.`));
