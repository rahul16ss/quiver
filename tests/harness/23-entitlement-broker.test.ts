/**
 * IntegrationBroker entitlement + conditions — behavioral tests (§9).
 *
 * Verifies: decide() returns permitted only when all conditions resolve;
 * invoke() re-runs decide() and refuses on unresolved conditions (a caller
 * that ignores decide() still cannot invoke); rights matrix (no llm-processing
 * right → denied); network-zone (public-internet integration blocked in
 * air-gapped); timeout; output-size. Bounded exit.
 */
import picocolors from "picocolors";
import { QuiverIntegrationBroker, type IntegrationHandler } from "../../src/harness/integration-broker.js";
import { buildExecutionContext } from "../../src/security/execution_context.js";
import type { IntegrationDeclaration } from "../../src/harness/interfaces.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

function handler(decl: Partial<IntegrationDeclaration> & { name: string }, invokeFn?: (i: unknown) => Promise<unknown>): IntegrationHandler {
  return {
    declaration: {
      name: decl.name, label: decl.label ?? decl.name, capabilities: decl.capabilities ?? [],
      authScopes: decl.authScopes ?? [], dataClassification: decl.dataClassification ?? "public",
      readWrite: decl.readWrite ?? "read", requiredApprovals: decl.requiredApprovals ?? [],
      licensedDataRestrictions: decl.licensedDataRestrictions ?? [], health: decl.health ?? "healthy",
      rights: decl.rights, networkZone: decl.networkZone, timeoutMs: decl.timeoutMs, maxOutputBytes: decl.maxOutputBytes,
    } as IntegrationDeclaration,
    invoke: invokeFn ?? (async () => "ok"),
  };
}

async function run() {
  // ── conditions must resolve before permission ──
  const b1 = new QuiverIntegrationBroker();
  b1.register(handler({ name: "bloomberg", requiredApprovals: ["human-signoff"], rights: { rights: ["llm-processing"] } }));
  let d = b1.decide("bloomberg");
  check("DECIDE-DENIES-UNRESOLVED-CONDITION", d.permitted === false && d.conditions.some((c) => !c.resolved));
  check("DECIDE-CONDITION-ID", d.conditions.some((c) => c.id === "approval-required"));
  // Resolving the approval condition permits.
  d = b1.decide("bloomberg", { approvals: ["human-signoff"] });
  check("DECIDE-PERMITS-WHEN-RESOLVED", d.permitted === true);

  // ── invoke() refuses even if caller ignores decide() ──
  const r = await b1.invoke("bloomberg", {});
  check("INVOKE-REFUSES-UNRESOLVED", r.ok === false && /policy denied/.test(r.error ?? ""), `got ${r.error}`);

  // ── rights: no llm-processing right → denied ──
  const b2 = new QuiverIntegrationBroker();
  b2.register(handler({ name: "vendor-no-llm", rights: { rights: ["internal-use"] } }));
  const d2 = b2.decide("vendor-no-llm");
  check("RIGHTS-NO-LLM-DENIED", d2.permitted === false && d2.conditions.some((c) => c.id === "entitlement-llm-processing"));
  const r2 = await b2.invoke("vendor-no-llm", {});
  check("RIGHTS-NO-LLM-INVOKE-REFUSED", r2.ok === false);

  // ── network-zone: public-internet integration blocked in air-gapped ──
  const b3 = new QuiverIntegrationBroker();
  b3.register(handler({ name: "public-api", networkZone: "public-internet", rights: { rights: ["llm-processing"] } }));
  const airCtx = buildExecutionContext({ runId: "r", customer: "c", actor: "a", dataClassification: "public", profile: "air-gapped", traceId: "t" });
  const d3 = b3.decide("public-api", { executionContext: airCtx });
  check("NETWORK-ZONE-BLOCKED-AIR-GAPPED", d3.permitted === false && d3.conditions.some((c) => c.id === "network-zone"));
  // connected-zdr permits.
  const connCtx = buildExecutionContext({ runId: "r2", customer: "c", actor: "a", dataClassification: "public", profile: "connected-zdr", traceId: "t2" });
  const d3b = b3.decide("public-api", { executionContext: connCtx });
  check("NETWORK-ZONE-PERMITTED-CONNECTED", d3b.permitted === true);

  // ── timeout enforcement ──
  const b4 = new QuiverIntegrationBroker();
  b4.register(handler({ name: "slow", timeoutMs: 100, rights: { rights: ["llm-processing"] } }, async () => { await new Promise((r) => setTimeout(r, 500)); return "late"; }));
  const r4 = await b4.invoke("slow", {});
  check("TIMEOUT-ENFORCED", r4.ok === false && /timed out after 100ms/.test(r4.error ?? ""), `got ${r4.error}`);

  // ── output-size enforcement ──
  const b5 = new QuiverIntegrationBroker();
  b5.register(handler({ name: "big", maxOutputBytes: 10, rights: { rights: ["llm-processing"] } }, async () => "x".repeat(100)));
  const r5 = await b5.invoke("big", {});
  check("OUTPUT-SIZE-ENFORCED", r5.ok === false && /exceeds maxOutputBytes/.test(r5.error ?? ""), `got ${r5.error}`);

  // ── sensitivity: restricted-mnpi on public integration denied ──
  const b6 = new QuiverIntegrationBroker();
  b6.register(handler({ name: "pub-feed", dataClassification: "public", rights: { rights: ["llm-processing"] } }));
  const d6 = b6.decide("pub-feed", { sensitivity: "restricted-mnpi" });
  check("MNPI-ON-PUBLIC-DENIED", d6.permitted === false && d6.conditions.some((c) => c.id === "sensitivity-mismatch"));

  // ── a permitted invoke returns data + provenance ──
  const b7 = new QuiverIntegrationBroker();
  b7.register(handler({ name: "ok-int", rights: { rights: ["llm-processing"] } }, async () => ({ value: 42 })));
  const r7 = await b7.invoke("ok-int", {});
  check("PERMITTED-INVOKE-RETURNS-DATA", r7.ok === true && (r7.data as any)?.value === 42);
  check("PERMITTED-INVOICE-PROVENANCE", !!r7.provenance && r7.provenance.vendor === "ok-int");

  console.log(failed === 0
    ? picocolors.green(`\n   ✔ All ${passed} entitlement-broker checks passed`)
    : picocolors.red(`\n   ✗ ${failed}/${passed + failed} checks FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
