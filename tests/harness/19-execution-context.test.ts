/**
 * ExecutionContext + Deployment Profiles — behavioral tests (§7).
 *
 * Verifies air-gapped enforcement is below the app layer (a direct fetch to a
 * public host is rejected), external tools are removed from the registry, and
 * the three profiles resolve correctly. No network egress — the guard itself
 * is what we test. Bounded, clean exit.
 */
import picocolors from "picocolors";
import {
  resolveDeploymentProfile,
  profileConfig,
  isHostReachable,
  installNetworkGuard,
  buildExecutionContext,
  filterToolsByContext,
  type ExecutionContext,
} from "../../src/security/execution_context.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  // ── profile resolution ──
  check("PROFILE-DEFAULT", resolveDeploymentProfile("") === "connected-zdr");
  check("PROFILE-AIR-GAPPED", resolveDeploymentProfile("air-gapped") === "air-gapped");
  check("PROFILE-PRIVATE", resolveDeploymentProfile("private-network") === "private-network");

  // ── profile config ──
  check("CONNECTED-ALLOWS-EXTERNAL", profileConfig("connected-zdr").allowExternalNetwork === true);
  check("AIR-GAPPED-BLOCKS-EXTERNAL", profileConfig("air-gapped").allowExternalNetwork === false);
  check("AIR-GAPPED-NO-CLOUD-MODEL", profileConfig("air-gapped").allowCloudModelGateway === false);
  check("AIR-GAPPED-NO-AUTO-UPDATE", profileConfig("air-gapped").allowAutoUpdates === false);
  check("AIR-GAPPED-REMOVES-WEB-TOOLS",
    profileConfig("air-gapped").removedTools.includes("web_search") &&
    profileConfig("air-gapped").removedTools.includes("deep_research"));
  check("PRIVATE-KEEPS-LOOPBACK", profileConfig("private-network").allowLoopback === true);

  // ── host reachability ──
  check("CONNECTED-REACHES-PUBLIC", isHostReachable("api.parallel.ai", "connected-zdr") === true);
  check("AIR-GAPPED-LOOPBACK-OK", isHostReachable("127.0.0.1", "air-gapped") === true);
  check("AIR-GAPPED-PUBLIC-BLOCKED", isHostReachable("api.parallel.ai", "air-gapped") === false);
  check("PRIVATE-PUBLIC-BLOCKED", isHostReachable("api.openrouter.ai", "private-network") === false);
  check("PRIVATE-ALLOWLIST", isHostReachable("intranet.corp", "private-network", ["corp"]) === true);

  // ── network guard blocks a public fetch in air-gapped (below app layer) ──
  const teardown = installNetworkGuard("air-gapped");
  let blocked = false;
  try {
    await fetch("https://api.parallel.ai/v1/search");
  } catch (e) {
    blocked = /Network blocked by deployment profile 'air-gapped'/.test((e as Error).message);
  }
  check("AIR-GAPPED-FETCH-BLOCKED-BELOW-APP", blocked, "fetch to public host must throw");
  // loopback is still allowed
  let loopbackOk = true;
  try {
    // A loopback fetch will fail to connect (no server) but must NOT be blocked by the guard.
    await fetch("http://127.0.0.1:1/");
  } catch (e) {
    loopbackOk = !/Network blocked by deployment profile/.test((e as Error).message);
  }
  check("AIR-GAPPED-LOOPBACK-FETCH-ALLOWED", loopbackOk);
  teardown();
  // After teardown, connected fetch is unguarded (no block error).
  check("GUARD-TEARDOWN-RESTORES", (() => {
    const f: any = globalThis.fetch;
    return typeof f === "function" && !("originalFetch" in f);
  })());

  // ── context immutability ──
  const ctx = buildExecutionContext({
    runId: "r1", customer: "acme", actor: "analyst",
    dataClassification: "restricted-mnpi", profile: "air-gapped",
    allowedTools: ["office_doc", "web_search", "evidence"], traceId: "t1",
  });
  check("CTX-IMMUTABLE", Object.isFrozen(ctx));
  let mutationThrew = false;
  try { (ctx as any).runId = "x"; } catch { mutationThrew = true; }
  check("CTX-MUTATION-THROWS", mutationThrew);

  // ── context removes external tools in air-gapped ──
  check("CTX-REMOVES-WEB-SEARCH", !ctx.toolPermissions.allowed.has("web_search"));
  check("CTX-KEEPS-OFFICE-DOC", ctx.toolPermissions.allowed.has("office_doc"));
  check("CTX-ALLOWED-ZONE-LOOPBACK", ctx.allowedZone === "loopback");

  // ── tool registry filter ──
  const tools = [{ name: "office_doc" }, { name: "web_search" }, { name: "deep_research" }, { name: "evidence" }];
  const filtered = filterToolsByContext(tools, ctx);
  check("FILTER-REMOVES-EXTERNAL", filtered.every((t) => t.name !== "web_search" && t.name !== "deep_research"));
  check("FILTER-KEEPS-OFFICE", filtered.some((t) => t.name === "office_doc"));

  // ── connected-zdr keeps all tools ──
  const ctxC = buildExecutionContext({
    runId: "r2", customer: "acme", actor: "analyst",
    dataClassification: "public", profile: "connected-zdr", traceId: "t2",
  });
  const filteredC = filterToolsByContext(tools, ctxC);
  check("CONNECTED-KEEPS-ALL-TOOLS", filteredC.length === tools.length);

  // ── high-sensitivity in air-gapped cannot reach a network tool ──
  const ctxM = buildExecutionContext({
    runId: "r3", customer: "acme", actor: "analyst",
    dataClassification: "highly-sensitive", profile: "air-gapped", traceId: "t3",
  });
  const filteredM = filterToolsByContext(tools, ctxM);
  check("MNPI-AIR-GAPPED-NO-NETWORK-TOOLS",
    filteredM.every((t) => t.name !== "web_search" && t.name !== "deep_research"),
    "high-sensitivity + air-gapped must not include network tools");

  console.log(failed === 0
    ? picocolors.green(`\n   ✔ All ${passed} ExecutionContext checks passed`)
    : picocolors.red(`\n   ✗ ${failed}/${passed + failed} checks FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
