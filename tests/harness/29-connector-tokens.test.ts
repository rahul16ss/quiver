/**
 * ConnectorTokenManager behavioral tests (§10/§7).
 *
 * Proves OAuth tokens persist + resolve through the TokenStore seam (the OS
 * credential store in production, an in-memory test seam here), that expired
 * access tokens are treated as invalid (caller must refresh from the stored
 * refresh token), and that clear() revokes. Deterministic exit; no network,
 * no real keychain.
 */
import picocolors from "picocolors";
import { ConnectorTokenManager, InMemoryTokenStore, KeychainTokenStore } from "../../src/harness/connector-tokens.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
	else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
	const store = new InMemoryTokenStore();
	const mgr = new ConnectorTokenManager("sharepoint", store);

	// ── Cold: no tokens ────────────────────────────────────────────────
	check("COLD-NO-ACCESS", !(await mgr.hasValidAccess()));
	const cold = await mgr.load();
	check("COLD-LOAD-EMPTY", !cold.accessToken && !cold.refreshToken);

	// ── Persist access + refresh → resolve back ─────────────────────────
	const now = Date.now();
	const future = now + 3600_000; // +1h
	await mgr.persist({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: future });
	check("HAS-VALID-ACCESS", await mgr.hasValidAccess());
	const loaded = await mgr.load();
	check("ACCESS-SURVIVES", loaded.accessToken === "acc-1", JSON.stringify(loaded));
	check("REFRESH-SURVIVES", loaded.refreshToken === "ref-1");

	// ── Expired access token → invalid, refresh preserved ──────────────
	await mgr.persist({ accessToken: "acc-old", refreshToken: "ref-1", expiresAt: now - 1 }); // expired
	check("EXPIRED-ACCESS-INVALID", !(await mgr.hasValidAccess()));
	const expired = await mgr.load();
	check("EXPIRED-KEEPS-REFRESH", !expired.accessToken && expired.refreshToken === "ref-1", JSON.stringify(expired));

	// ── Refresh replaces the access token ──────────────────────────────
	await mgr.persist({ accessToken: "acc-new", refreshToken: "ref-1", expiresAt: future });
	check("REFRESHED-ACCESS-VALID", (await mgr.load()).accessToken === "acc-new");

	// ── Isolated per-connector (no cross-contamination) ────────────────
	const driveMgr = new ConnectorTokenManager("drive", store);
	await driveMgr.persist({ accessToken: "d-acc", refreshToken: "d-ref", expiresAt: future });
	check("CONNECTORS-ISOLATED", (await mgr.load()).accessToken === "acc-new" && (await driveMgr.load()).accessToken === "d-acc");

	// ── clear() revokes both connectors independently ──────────────────
	await driveMgr.clear();
	check("CLEAR-REVOKES-ONE", !(await driveMgr.hasValidAccess()) && (await mgr.hasValidAccess()));

	// ── Keychain store prefixes keys under the expected namespace ──────
	const kc = new KeychainTokenStore();
	check("KEYCHAIN-PREFIX", (kc as any).key("sharepoint:oauthtoken:access") === "quiver:connector:sharepoint:oauthtoken:access");
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} connector-token check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} connector-token checks passed.`));
