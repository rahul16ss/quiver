/**
 * Harness acceptance tests — Phase 1.
 *
 * These tests assert the narrow interfaces and their first concrete
 * implementations. They are additive and do not touch the legacy 447-check
 * spec gate. A failure here fails `npm test` via tests/harness/run.ts.
 */
import picocolors from "picocolors";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  emptyPack,
  validateCustomerPack,
  packHash,
  diffPacks,
  CustomerPackRegistry,
} from "../../src/harness/customer-pack.js";
import { QuiverPolicyEngine } from "../../src/harness/policy-engine.js";
import { LocalArtifactRepository } from "../../src/harness/artifact-repository.js";
import { LocalTraceSink } from "../../src/harness/trace-sink.js";
import { QuiverPromptCompiler } from "../../src/harness/prompt-compiler.js";
import type { CustomerPack } from "../../src/harness/customer-pack.js";
import type { IntegrationDeclaration } from "../../src/harness/interfaces.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(picocolors.green(`   ✔ PASS  ${name}`));
  } else {
    failed++;
    const msg = `${name}${detail ? " — " + detail : ""}`;
    failures.push(msg);
    console.log(picocolors.red(`   ✗ FAIL  ${msg}`));
  }
}

async function run() {
  // ── CustomerPack validation ────────────────────────────────────────
  const good = emptyPack({ id: "acme", label: "Acme Capital" });
  const goodResult = validateCustomerPack(good);
  check("PACK-VALID-DEFAULT", goodResult.valid, goodResult.errors.join("; "));

  const withSecret = { ...good, apiKey: "sk-leak" } as unknown as CustomerPack;
  const secretResult = validateCustomerPack(withSecret);
  check("PACK-REJECTS-SECRET", !secretResult.valid && secretResult.errors.some((e) => /apiKey/i.test(e)));

  const autoPromote = { ...good, memory: { ...good.memory, autoPromote: true as unknown as false } } as unknown as CustomerPack;
  const apResult = validateCustomerPack(autoPromote);
  check("PACK-REJECTS-AUTO-PROMOTE", !apResult.valid && apResult.errors.some((e) => /autoPromote/i.test(e)));

  const mnpiCloud = {
    ...good,
    sensitivityProfiles: [
      { name: "restricted-mnpi" as const, parallelAllowed: false, cloudInferenceAllowed: true },
    ],
  } as unknown as CustomerPack;
  const mnpiResult = validateCustomerPack(mnpiCloud);
  check("PACK-REJECTS-MNPI-CLOUD-NO-LOCAL", !mnpiResult.valid);

  // Hash + diff are deterministic.
  check("PACK-HASH-STABLE", packHash(good) === packHash(good));
  const v2 = emptyPack({ id: "acme", label: "Acme Capital v2" });
  const d = diffPacks(good, v2);
  check("PACK-DIFF-DETECTS-LABEL", d.changed.some((c) => c.path === "label"));

  // Registry load/export/rollback.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-pack-"));
  const packFile = path.join(tmp, "acme.json");
  fs.writeFileSync(packFile, JSON.stringify(good, null, 2));
  const reg = new CustomerPackRegistry();
  const rec = reg.loadFromFile(packFile);
  check("PACK-REGISTRY-LOAD", rec.pack.id === "acme");
  check("PACK-EXPORT-NO-SECRET", !/sk-leak/.test(reg.exportPack("acme")));
  // Rollback history.
  const v2File = path.join(tmp, "acme-v2.json");
  fs.writeFileSync(v2File, JSON.stringify(v2, null, 2));
  reg.loadFromFile(v2File);
  check("PACK-VERSIONS-RECORDED", reg.versions("acme").length === 2);
  const rolled = reg.rollback("acme", rec.hash);
  check("PACK-ROLLBACK", !!rolled && rolled.hash === rec.hash);

  // ── PolicyEngine ───────────────────────────────────────────────────
  const pack = emptyPack({
    id: "acme",
    sensitivityProfiles: [
      { name: "public", parallelAllowed: true, cloudInferenceAllowed: true },
      { name: "confidential-internal", parallelAllowed: true, parallelSanitizedOnly: true, cloudInferenceAllowed: true },
      { name: "restricted-mnpi", parallelAllowed: false, cloudInferenceAllowed: false, localRouteSlug: "local-1" },
    ],
    dataVendorEntitlements: [
      { connector: "edgar", datasets: ["filings-ir"], redistributionAllowed: false, cacheExpirySeconds: 3600 },
    ],
  });
  const engine = new QuiverPolicyEngine(pack);

  const pubModel = engine.decide({ kind: "model", sensitivity: "public" });
  check("POLICY-PUBLIC-MODEL-OPENROUTER", pubModel.permitted && pubModel.enforcedRoute === "openrouter");

  const ciModel = engine.decide({ kind: "model", sensitivity: "confidential-internal" });
  check("POLICY-CI-MODEL-OPENROUTER-ZDR", ciModel.permitted && ciModel.enforcedRoute === "openrouter" && (ciModel.conditions?.length ?? 0) > 0);

  const mnpiModel = engine.decide({ kind: "model", sensitivity: "restricted-mnpi" });
  check("POLICY-MNPI-MODEL-LOCAL", mnpiModel.permitted && mnpiModel.enforcedRoute === "local");

  const mnpiResearch = engine.decide({ kind: "research", sensitivity: "restricted-mnpi" });
  check("POLICY-MNPI-RESEARCH-DENIED", !mnpiResearch.permitted);

  const ciResearch = engine.decide({ kind: "research", sensitivity: "confidential-internal" });
  check("POLICY-CI-RESEARCH-SANITIZED", ciResearch.permitted && (ciResearch.conditions?.some((c) => /sanit/i.test(c)) ?? false));

  // Fail closed when no local route configured for MNPI.
  const noLocalPack = emptyPack({
    id: "no-local",
    sensitivityProfiles: [
      { name: "restricted-mnpi", parallelAllowed: false, cloudInferenceAllowed: false },
    ],
  });
  const noLocalEngine = new QuiverPolicyEngine(noLocalPack);
  const noLocalDecision = noLocalEngine.decide({ kind: "model", sensitivity: "restricted-mnpi" });
  check("POLICY-MNPI-FAIL-CLOSED-NO-LOCAL", !noLocalDecision.permitted && /fail.*closed|no OpenRouter fallback/i.test(noLocalDecision.reasons.join(" ")));

  // Source-category resolution: missing category surfaces a warning, no silent substitution.
  const decls: IntegrationDeclaration[] = [
    { name: "edgar", label: "EDGAR", capabilities: ["fetch"], authScopes: [], dataClassification: "public", readWrite: "read", requiredApprovals: [], licensedDataRestrictions: [], health: "healthy" },
  ];
  const res = engine.resolveSourceCategories(["filings-ir", "market-data-estimates"], decls);
  check("POLICY-SOURCE-RESOLVE-FOUND", res.resolved.some((r) => r.category === "filings-ir" && r.connector === "edgar"));
  check("POLICY-SOURCE-RESOLVE-MISSING-WARN", res.missing.includes("market-data-estimates") && res.substitutionWarnings.length > 0);
  check("POLICY-SOURCE-PUBLIC-WEB-TO-PARALLEL", engine.resolveSourceCategories(["public-web-research"], decls).resolved[0]?.connector === "parallel");

  // ── ArtifactRepository ─────────────────────────────────────────────
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-art-"));
  const repo = new LocalArtifactRepository(stageDir);
  const staged = await repo.stage(
    { identity: { id: "src-1", path: "/tmp/model.xlsx" }, data: Buffer.from("source-bytes"), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    "RUN-1",
  );
  check("ART-SNAPSHOT-CREATED", fs.existsSync(staged.snapshotPath));
  check("ART-WORKING-COPY-CREATED", fs.existsSync(staged.workingCopyPath));
  check("ART-SNAPSHOT-HASH", staged.sourceHash.length === 64);

  const candidate = await repo.recordCandidate(staged, { path: "out.xlsx", data: Buffer.from("candidate-bytes"), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  check("ART-CANDIDATE-CREATED", fs.existsSync(candidate.candidatePath));

  await repo.attachEvidence(candidate, { claims: [] });
  check("ART-EVIDENCE-ATTACHED", fs.existsSync(path.join(stageDir, "RUN-1", "evidence.json")));

  const diff = await repo.diff(staged, candidate);
  check("ART-DIFF-STRUCTURAL", diff.changes.length > 0);

  // Commit rejected before approval.
  let commitRejected = false;
  try {
    await repo.commit(candidate);
  } catch {
    commitRejected = true;
  }
  check("ART-COMMIT-REJECTED-BEFORE-APPROVAL", commitRejected);

  await repo.setApproval(candidate, { reviewer: "jane", items: [{ locator: "line:1", decision: "accepted" }], overall: "accepted" });
  check("ART-APPROVAL-ACCEPTED", candidate.approval.status === "accepted");
  const committed = await repo.commit(candidate);
  check("ART-COMMIT-AFTER-APPROVAL", !!committed.committedIdentity.id);
  check("ART-COMMIT-PROVENANCE", committed.provenance.sourceHash === staged.sourceHash);

  // ── TraceSink redaction ─────────────────────────────────────────────
  const sink = new LocalTraceSink();
  const span = sink.startSpan("model.invoke", { model: "gpt-x", prompt: "super secret thesis", content: "doc bytes" });
  sink.event(span, "tool.call", { toolName: "web_search", toolResult: "secret excerpts" });
  sink.endSpan(span, { finishReason: "stop" });
  const snap = sink.snapshot();
  check("TRACE-REDACTS-PROMPT", snap.spans[0].attrs.prompt === "[redacted]");
  check("TRACE-REDACTS-CONTENT", snap.spans[0].attrs.content === "[redacted]");
  check("TRACE-KEEPS-MODEL", snap.spans[0].attrs.model === "gpt-x");
  const ev = snap.events[0];
  check("TRACE-REDACTS-TOOL-RESULT", ev.attrs?.toolResult === "[redacted]");
  check("TRACE-KEEPS-TOOL-NAME", ev.attrs?.toolName === "web_search");

  // ── PromptCompiler layers ───────────────────────────────────────────
  const compiler = new QuiverPromptCompiler(pack);
  const compiled = compiler.compile({
    role: "maker",
    goal: { objective: "IC memo", definitionOfDone: ["all figures sourced"] },
    approvedContext: "Project Alder (synthetic)",
    gapLedger: [{ id: "g1", description: "need consensus", category: "market-data-estimates", status: "open" }],
  });
  check("PROMPT-LAYERS-ORDER", compiled.layers.map((l) => l.name).slice(0, 3).join("|") === "Runtime invariants & safety|Capital-markets domain policy|Customer pack");
  check("PROMPT-INCLUDES-ROLE", /maker/i.test(compiled.systemPrompt));
  check("PROMPT-INCLUDES-GOAL", /IC memo/.test(compiled.systemPrompt));
  check("PROMPT-INCLUDES-GAP-LEDGER", /Gap ledger/.test(compiled.systemPrompt));
  check("PROMPT-PACK-REF", compiler.pack().id === "acme");
  check("PROMPT-NO-DEVELOPER-ADDRESSING", !/you are a software developer/i.test(compiled.systemPrompt));
}

await run();

if (failed > 0) {
  console.log(picocolors.red(`\n❌ ${failed} harness check(s) FAILED.`));
  process.exit(1);
}
console.log(picocolors.cyan(`\n  ✔ ${passed} harness checks passed.`));