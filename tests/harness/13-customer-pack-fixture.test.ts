/**
 * CustomerPack fixture + PromptCompiler integration — Phase 5 (ADR-004).
 *
 * Loads the shipped Conviction Studio default pack (data, not a code fork),
 * validates it (secret-free, fail-closed MNPI, no auto-promote), and compiles
 * prompts from its prompt modules. Verifies the pack's twelve workflow specs
 * match the harness WorkflowSpec catalog, and that the PromptCompiler layers
 * the customer pack + domain policy + role + goal + gap ledger.
 */
import picocolors from "picocolors";
import * as path from "path";
import * as fs from "fs";
import { CustomerPackRegistry, validateCustomerPack, packHash, type CustomerPack } from "../../src/harness/customer-pack.js";
import { QuiverPromptCompiler } from "../../src/harness/prompt-compiler.js";
import { QuiverPolicyEngine } from "../../src/harness/policy-engine.js";
import { TWELVE_WORKFLOW_SPECS } from "../../src/harness/workflow-spec.js";
import { ALL_SOURCE_CATEGORIES } from "../../src/harness/interfaces.js";
import { assemblePrompt } from "../../src/prompt/assembler.js";
import { getAdapter } from "../../src/adapters/types.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  const packPath = path.resolve("packs/conviction-studio-default/pack.json");
  const raw = JSON.parse(fs.readFileSync(packPath, "utf8"));

  // ── Pack validation ─────────────────────────────────────────────────
  const result = validateCustomerPack(raw);
  check("PACK-FILE-VALID", result.valid, result.errors.join("; "));
  if (!result.valid) { console.log(picocolors.red("\n❌ pack invalid; aborting.")); process.exit(1); }

  const pack = raw as CustomerPack;
  check("PACK-NO-SECRETS", !/sk-|api_key=|password=|Bearer /i.test(JSON.stringify(pack)));
  check("PACK-MNPI-FAIL-CLOSED", pack.sensitivityProfiles.find((p) => p.name === "restricted-mnpi")?.cloudInferenceAllowed === false);
  check("PACK-MEMORY-NO-AUTO-PROMOTE", pack.memory.autoPromote === false);
  check("PACK-HASH-STABLE", packHash(pack) === packHash(pack));

  // ── Registry load/export/rollback ───────────────────────────────────
  const reg = new CustomerPackRegistry();
  const rec = reg.loadFromFile(packPath);
  check("PACK-REGISTRY-LOADS-FILE", rec.pack.id === "conviction-studio-default");
  const exported = reg.exportPack(rec.pack.id);
  check("PACK-EXPORT-ROUNDTRIPS", JSON.parse(exported).id === rec.pack.id);

  // ── Twelve workflow specs match the harness catalog ─────────────────
  check("PACK-WORKFLOWS-ARE-TWELVE", pack.workflowSpecs.length === 12);
  const harnessIds = new Set(TWELVE_WORKFLOW_SPECS.map((s) => s.id));
  check("PACK-WORKFLOWS-MATCH-HARNESS", pack.workflowSpecs.every((id) => harnessIds.has(id)));

  // ── Source precedence covers all categories ─────────────────────────
  const precCats = new Set(pack.sourcePrecedence.map((p) => p.category));
  check("PACK-PRECEDENCE-COVERS-ALL-CATEGORIES", ALL_SOURCE_CATEGORIES.every((c) => precCats.has(c)));

  // ── Approved models reference certified-profile-style slugs ─────────
  check("PACK-APPROVED-MODELS-HAVE-PROVIDER-ORDER", pack.approvedModels.every((m) => m.providerOrder.length > 0));

  // ── PromptCompiler compiles from the pack ───────────────────────────
  const compiler = new QuiverPromptCompiler(pack);
  const compiled = compiler.compile({
    role: "maker",
    goal: { objective: "Earnings update memo", definitionOfDone: ["all figures sourced", "checker passed"] },
    approvedContext: "ACME Q1 (synthetic public filing)",
    gapLedger: [{ id: "g1", description: "consensus estimates", category: "market-data-estimates", status: "open" }],
    workflowSpecId: "earnings-update",
  });
  check("PROMPT-COMPILED-FROM-PACK", compiled.systemPrompt.length > 0);
  check("PROMPT-LAYERS-INCLUDE-PACK", compiled.layers.some((l) => l.name === "Customer pack" && l.included));
  check("PROMPT-INCLUDES-DOMAIN-POLICY-MODULE", /separate fact/i.test(compiled.systemPrompt) || /capital-markets/i.test(compiled.systemPrompt));
  check("PROMPT-INCLUDES-HOUSE-TERMINOLOGY", /Investment Committee|IC/.test(compiled.systemPrompt));
  check("PROMPT-INCLUDES-SOURCE-PRECEDENCE", /source precedence|filings-ir/i.test(compiled.systemPrompt));
  check("PROMPT-INCLUDES-GAP-LEDGER", /Gap ledger/.test(compiled.systemPrompt));
  check("PROMPT-INCLUDES-BANNED-PHRASES", /guaranteed return|sure thing/i.test(compiled.systemPrompt));
  check("PROMPT-NO-DEVELOPER-ADDRESSING", !/you are a software developer/i.test(compiled.systemPrompt));
  check("PROMPT-PACK-REF-ID", compiler.pack().id === "conviction-studio-default");

  // ── Assembler pack-injection seam (ADR-004) ──────────────────────────
  const assembled = assemblePrompt(
    { identity: "You are Quiver.", safetyPolicy: "Be safe.", adapterInstructions: "i", toolInstructions: "t", memoryContext: "m", projectContext: "p", conversationSummary: "", recentMessages: [], currentUserRequest: "", customerPack: pack },
    getAdapter("default"),
    { id: "t", displayName: "T", providerId: "t", contextWindowTokens: 120000, supportsTools: true, supportsParallelToolCalls: true, supportsImages: false, supportsStreaming: true, supportsReasoningSummaries: false } as any,
  );
  check("ASSEMBLER-INSERTS-CUSTOMER-PACK-SECTION", assembled.sections.some((s) => s.name === "Customer pack" && s.included));
  check("ASSEMBLER-INSERTS-DOMAIN-POLICY-SECTION", assembled.sections.some((s) => s.name === "Capital-markets domain policy" && s.included));
  check("ASSEMBLER-PRESERVES-SAFETY-POLICY", assembled.sections.some((s) => s.name === "Safety Policy" && s.included));
  check("ASSEMBLER-PACK-CONTENT-HAS-TERMINOLOGY", /Investment Committee|IC/.test(assembled.sections.find((s) => s.name === "Customer pack")?.content ?? ""));

  // Without a pack, the legacy 9-section assembly is unchanged.
  const noPack = assemblePrompt(
    { identity: "You are Quiver.", safetyPolicy: "Be safe.", adapterInstructions: "i", toolInstructions: "t", memoryContext: "m", projectContext: "p", conversationSummary: "", recentMessages: [], currentUserRequest: "" },
    getAdapter("default"),
    { id: "t", displayName: "T", providerId: "t", contextWindowTokens: 120000, supportsTools: true, supportsParallelToolCalls: true, supportsImages: false, supportsStreaming: true, supportsReasoningSummaries: false } as any,
  );
  check("ASSEMBLER-NO-PACK-NO-CUSTOMER-SECTION", !noPack.sections.some((s) => s.name === "Customer pack"));

  // ── PolicyEngine bound to the pack enforces the three profiles ──────
  const policy = new QuiverPolicyEngine(pack);
  check("PACK-POLICY-PUBLIC-OPENROUTER", policy.decide({ kind: "model", sensitivity: "public" }).enforcedRoute === "openrouter");
  check("PACK-POLICY-CI-SANITIZED-PARALLEL", policy.decide({ kind: "research", sensitivity: "confidential-internal" }).permitted);
  check("PACK-POLICY-MNPI-LOCAL", policy.decide({ kind: "model", sensitivity: "restricted-mnpi" }).enforcedRoute === "local");
  check("PACK-POLICY-MNPI-RESEARCH-DENIED", !policy.decide({ kind: "research", sensitivity: "restricted-mnpi" }).permitted);
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} pack/prompt check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} pack/prompt checks passed.`));