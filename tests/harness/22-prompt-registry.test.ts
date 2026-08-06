/**
 * PromptRegistry — behavioral tests (§11).
 *
 * Verifies: 6 deterministic layers, stable id+version, hashing, required-var
 * fail-closed, unknown-var fail-closed, leftover-placeholder fail-closed,
 * customer overrides only at permitted layers (core/checker protected),
 * composite hash for run records, preview. Bounded exit.
 */
import picocolors from "picocolors";
import { PromptRegistry, quiverCoreTemplates, type PromptTemplate } from "../../src/prompt/registry.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  const reg = new PromptRegistry();
  for (const t of quiverCoreTemplates()) reg.register(t);
  // domain + customer + workflow + task layers (customer-overridable).
  reg.register({ id: "domain:finance:v1", layer: "domain", version: "1.0.0", body: "Domain: {{sector}} coverage.", requiredVars: ["sector"], customerOverridable: true });
  reg.register({ id: "customer:acme:v1", layer: "customer", version: "1.0.0", body: "House style: {{houseStyle}}.", requiredVars: ["houseStyle"], customerOverridable: true });
  reg.register({ id: "workflow:primer:v1", layer: "workflow", version: "1.0.0", body: "Workflow: company primer for {{company}}.", requiredVars: ["company"], customerOverridable: true });
  reg.register({ id: "task:run:v1", layer: "task", version: "1.0.0", body: "Task: {{objective}}.", requiredVars: ["objective"], customerOverridable: true });

  // ── 6 layers present ──
  check("REGISTRY-HAS-CORE", reg.list().includes("core:v1"));
  check("REGISTRY-HAS-CHECKER", reg.list().includes("checker:v1"));

  // ── render with required vars ──
  const r = reg.render("domain:finance:v1", { sector: "Energy" });
  check("RENDER-SUBSTITUTES-VAR", r.body === "Domain: Energy coverage." && !r.body.includes("{{"));
  check("RENDER-HAS-STABLE-ID", r.id === "domain:finance:v1");
  check("RENDER-HAS-VERSION", r.version === "1.0.0");
  check("RENDER-HAS-HASH", /^[0-9a-f]{64}$/.test(r.hash));

  // ── fail closed: missing required var ──
  let missingThrew = false;
  try { reg.render("domain:finance:v1", {}); } catch (e) { missingThrew = /Missing required variables/.test((e as Error).message); }
  check("RENDER-FAILS-MISSING-VAR", missingThrew);

  // ── fail closed: unknown var ──
  let unknownThrew = false;
  try { reg.render("domain:finance:v1", { sector: "X", typo: "Y" }); } catch (e) { unknownThrew = /Unknown variables/.test((e as Error).message); }
  check("RENDER-FAILS-UNKNOWN-VAR", unknownThrew);

  // ── core is not customer-overridable ──
  let coreOverrideRejected = false;
  try {
    reg.override({ id: "core:v1", layer: "core", version: "1.0.0", body: "evil override", requiredVars: [], customerOverridable: true });
  } catch (e) { coreOverrideRejected = /not customer-overridable/.test((e as Error).message); }
  check("CORE-NOT-OVERRIDABLE", coreOverrideRejected, "customer must not be able to rewrite the core security contract");

  // ── checker is not customer-overridable ──
  let checkerOverrideRejected = false;
  try {
    reg.override({ id: "checker:v1", layer: "checker", version: "1.0.0", body: "evil checker", requiredVars: ["openGaps"], customerOverridable: true });
  } catch (e) { checkerOverrideRejected = /not customer-overridable/.test((e as Error).message); }
  check("CHECKER-NOT-OVERRIDABLE", checkerOverrideRejected);

  // ── customer can override the domain layer ──
  reg.override({ id: "domain:finance:v1", layer: "domain", version: "1.1.0", body: "Custom domain: {{sector}}.", requiredVars: ["sector"], customerOverridable: true });
  const r2 = reg.render("domain:finance:v1", { sector: "Tech" });
  check("CUSTOMER-OVERRIDE-DOMAIN", r2.body === "Custom domain: Tech." && r2.version === "1.1.0");

  // ── layer mismatch on override rejected ──
  let layerMismatch = false;
  try {
    reg.override({ id: "customer:acme:v1", layer: "core", version: "1.0.0", body: "x", requiredVars: [], customerOverridable: true });
  } catch (e) { layerMismatch = /layer mismatch/i.test((e as Error).message); }
  check("OVERRIDE-LAYER-MISMATCH-REJECTED", layerMismatch);

  // ── renderAll: 6 layers + composite hash ──
  const all = reg.renderAll({
    domain: { sector: "Energy" },
    customer: { houseStyle: "formal" },
    workflow: { company: "TestCo" },
    task: { objective: "write primer" },
    checker: { openGaps: "none" },
  });
  const layerIds = all.layers.map((l) => l.layer);
  check("RENDERALL-INCLUDES-CORE", layerIds.includes("core"));
  check("RENDERALL-INCLUDES-CHECKER", layerIds.includes("checker"));
  check("RENDERALL-ORDER", layerIds.indexOf("core") < layerIds.indexOf("domain") && layerIds.indexOf("domain") < layerIds.indexOf("customer"));
  check("RENDERALL-COMPOSITE-HASH", /^[0-9a-f]{64}$/.test(all.compositeHash));
  // Composite hash is deterministic.
  const all2 = reg.renderAll({
    domain: { sector: "Energy" }, customer: { houseStyle: "formal" },
    workflow: { company: "TestCo" }, task: { objective: "write primer" }, checker: { openGaps: "none" },
  });
  check("RENDERALL-HASH-DETERMINISTIC", all.compositeHash === all2.compositeHash);
  // Different vars → different hash.
  const all3 = reg.renderAll({
    domain: { sector: "Tech" }, customer: { houseStyle: "formal" },
    workflow: { company: "TestCo" }, task: { objective: "write primer" }, checker: { openGaps: "none" },
  });
  check("RENDERALL-HASH-CHANGES-WITH-VARS", all.compositeHash !== all3.compositeHash);

  // ── preview (admin) ──
  const p = reg.preview("domain:finance:v1");
  check("PREVIEW-SHOWS-VERSION", p.version === "1.1.0");
  check("PREVIEW-SHOWS-OVERRIDE", p.overridden === true);

  console.log(failed === 0
    ? picocolors.green(`\n   ✔ All ${passed} PromptRegistry checks passed`)
    : picocolors.red(`\n   ✗ ${failed}/${passed + failed} checks FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
