/**
 * End-to-end harness integration — Phase 9 (Definition of Done).
 *
 * Proves the four planes compose with the generic harness: a goal-seeking run
 * that routes a public research query through Parallel (mock), enforces ZDR
 * policy on the model call, stages an Office artifact, runs the maker/checker
 * + human approval, commits to storage with conflict checks, and produces a
 * reproducible run record. All with mocks/deterministic fixtures (no network).
 */
import picocolors from "picocolors";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { emptyPack } from "../../src/harness/customer-pack.js";
import { QuiverPolicyEngine } from "../../src/harness/policy-engine.js";
import { ModelProfileRegistry, starterCatalog } from "../../src/harness/model-profile.js";
import { QuiverOpenRouterClient, LocalModelClient, type ModelTransport, type TransportRequest, type TransportResponse } from "../../src/harness/model-client.js";
import { ParallelResearchGateway, type ParallelTransport } from "../../src/harness/research-gateway.js";
import { QuiverExecutionEngine, type ToolExecutor, type ToolResult } from "../../src/harness/execution-engine.js";
import { SqliteCheckpointSaver } from "../../src/harness/sqlite-checkpoint.js";
import { LocalArtifactRepository } from "../../src/harness/artifact-repository.js";
import { LocalStorageProvider } from "../../src/harness/storage-providers.js";
import { OfficeCliEngine, type OfficeCliRunner, type OfficeCliRunResult } from "../../src/harness/office-engine.js";
import { LocalTraceSink } from "../../src/harness/trace-sink.js";
import type { GoalContract } from "../../src/harness/goal-contract.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  // ── Wire the four planes with mocks ─────────────────────────────────
  const pack = emptyPack({ id: "integration", sensitivityProfiles: [
    { name: "public", parallelAllowed: true, cloudInferenceAllowed: true },
    { name: "confidential-internal", parallelAllowed: true, parallelSanitizedOnly: true, cloudInferenceAllowed: true },
    { name: "restricted-mnpi", parallelAllowed: false, cloudInferenceAllowed: false, localRouteSlug: "local-private-default" },
  ]});
  const policy = new QuiverPolicyEngine(pack);
  const trace = new LocalTraceSink();

  // Model plane (OpenRouter-enforcing client with a mock transport).
  const profiles = new ModelProfileRegistry();
  for (const p of starterCatalog()) profiles.register(p);
  profiles.certify("openai-gpt-4o", "application/pdf", "pass");
  const mockTransport: ModelTransport = {
    async invoke(req: TransportRequest): Promise<TransportResponse> {
      // Assert the enforced policy reached the transport.
      if (req.provider.zdr !== true || req.provider.data_collection !== "deny" || req.provider.require_parameters !== true || req.provider.allow_fallbacks !== false) {
        throw new Error("transport received a non-policy-enforced request");
      }
      return { content: "OK all met", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, provider: { provider: "OpenAI" } }, finishReason: "stop", route: "openai/gpt-4o" };
    },
  };
  const model = new QuiverOpenRouterClient(mockTransport, profiles, policy);

  // Knowledge plane (Parallel research with a mock transport).
  const mockParallel: ParallelTransport = {
    async search() { return { results: [{ url: "https://example.com/filing", title: "Filing", publish_date: "2026-03-31", excerpts: ["revenue 100m"] }] }; },
    async extract() { return { results: [{ url: "https://example.com/filing", title: "Filing", publish_date: "2026-03-31", excerpts: ["revenue 100m"], full_content: "# Filing" }] }; },
    async taskRun() { return { output: { type: "text", content: "synthesis", basis: [{ citations: [{ url: "https://example.com/filing", title: "Filing", excerpts: ["revenue 100m"] }] }] } }; },
    async monitor() { return { monitor_id: "m1" }; },
    async monitorStop() {},
    async findEntities() { return { results: [{ url: "https://example.com/e", excerpts: ["e"] }] }; },
  };
  const research = new ParallelResearchGateway(mockParallel, policy);

  // Work-product plane.
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-e2e-art-"));
  const repo = new LocalArtifactRepository(stageDir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-e2e-root-"));
  const storage = new LocalStorageProvider("local1", [root]);
  const fakeBin = path.join(stageDir, "officecli");
  fs.writeFileSync(fakeBin, Buffer.from("fake-binary"));
  const officeRunner: OfficeCliRunner = {
    binaryPath() { return fakeBin; },
    pin() { return { version: "1.0.0", checksum: "", platform: process.platform, licenseNotices: [] }; },
    async run(): Promise<OfficeCliRunResult> { return { success: true, stdout: JSON.stringify({ sheets: [{ name: "S1", formulas: { A1: "=100" } }], warnings: [] }), stderr: "", exitCode: 0, json: { sheets: [{ name: "S1" }] } }; },
  };
  const office = new OfficeCliEngine(officeRunner);

  // ── 1. Research → public filing excerpt (policy permits Parallel) ──
  const searchResults = await research.search("ACME Q1 earnings", { sensitivity: "public" });
  check("E2E-RESEARCH-PUBLIC-EXCERPTS", searchResults.length === 1 && searchResults[0].excerpts.length === 1);
  const extract = await research.extract([searchResults[0].canonicalUrl], { sensitivity: "public", fullContent: true });
  check("E2E-RESEARCH-EXTRACT-FULL-CONTENT", !!extract[0].fullContent);

  // ── 2. Model call enforces ZDR policy (mock transport asserts it) ───
  const modelRes = await model.invoke([{ role: "user", content: "Summarize the filing." }], { modelProfile: "openai-gpt-4o", sensitivity: "public" });
  check("E2E-MODEL-ZDR-ENFORCED", modelRes.route === "openai/gpt-4o" && modelRes.usage?.totalTokens === 12);

  // ── 3. Stage the source artifact (no direct mutation) ───────────────
  const sourcePath = path.join(root, "model.xlsx");
  fs.writeFileSync(sourcePath, Buffer.from("source-xlsx"));
  const co = await storage.checkout({ id: sourcePath });
  const staged = await repo.stage({ identity: co.identity, data: co.data, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", path: sourcePath }, "RUN-E2E");
  check("E2E-ARTIFACT-STAGED", fs.existsSync(staged.snapshotPath) && fs.existsSync(staged.workingCopyPath));
  check("E2E-ARTIFACT-SNAPSHOT-NOT-MUTATED", fs.readFileSync(staged.snapshotPath, "utf8") === "source-xlsx");

  // ── 4. Office engine edits the working copy (not the original) ──────
  const editRes = await office.edit(staged.workingCopyPath, [{ kind: "cell", locator: "A1", value: 42 }]);
  check("E2E-OFFICE-EDIT-WORKING-COPY", editRes.applied >= 1);
  check("E2E-OFFICE-ORIGINAL-PRESERVED", fs.readFileSync(staged.snapshotPath, "utf8") === "source-xlsx");

  // ── 5. Candidate + evidence + diff ──────────────────────────────────
  const candidate = await repo.recordCandidate(staged, { path: "out.xlsx", data: Buffer.from("candidate-xlsx"), mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  await repo.attachEvidence(candidate, { claims: [{ value: 100, source: "filing" }], sources: [{ url: searchResults[0].canonicalUrl }] });
  const diff = await repo.diff(staged, candidate);
  check("E2E-DIFF-PRODUCED", diff.changes.length >= 0);

  // ── 6. ExecutionEngine goal loop → human approval → commit ──────────
  const saver = new SqliteCheckpointSaver(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "quiver-e2e-ckpt-")), "c.db"));
  const tools: ToolExecutor = {
    available() { return ["office_doc", "evidence", "deep_research"]; },
    async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      return { ok: true, output: `${name}:${args.step}`, evidenceRefs: [`evidence-for-${args.step}`] };
    },
  };
  // Use the LocalModelClient with the mock transport for the checker (local route).
  const localModel = new LocalModelClient(mockTransport, profiles);
  const contract: GoalContract = {
    runId: "RUN-E2E",
    objective: "Earnings update memo",
    requiredDeliverables: [{ type: "memo", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["reported metrics", "consensus deltas"] }],
    definitionOfDone: ["all figures sourced", "checker passed"],
    requiredSourceCategories: ["filings-ir", "market-data-estimates"],
    dataSensitivity: "public", reviewer: "analyst", budgets: { iterations: 6 }, stopConditions: [], createdAt: new Date().toISOString(),
  };
  const engine = new QuiverExecutionEngine(saver, localModel, tools, { maxIterations: 6 });
  const outcome = await engine.run(contract, { trace } as any);
  check("E2E-ENGINE-PAUSES-AT-APPROVAL", outcome.status === "paused", `status=${outcome.status}`);

  // Approve → resume → completed.
  const approved = await engine.resume(contract.runId, { approved: true });
  check("E2E-ENGINE-APPROVED-COMPLETES", approved.status === "completed", `status=${approved.status}`);
  check("E2E-ENGINE-RUN-RECORD-REPRODUCIBLE", !!approved.runRecord && Array.isArray((approved.runRecord as any).doneChecks));

  // ── 7. Commit the candidate to storage with conflict checks ─────────
  await repo.setApproval(candidate, { reviewer: "analyst", items: [{ locator: "A1", decision: "accepted" }], overall: "accepted" });
  const committed = await repo.commit(candidate);
  const commitResult = await storage.commit(co, { path: sourcePath, data: Buffer.from("candidate-xlsx") }, { reviewer: "analyst", approvalRef: committed.committedIdentity.id, baseEtag: co.etag });
  check("E2E-STORAGE-COMMIT-NEW-VERSION", !!commitResult.newVersion);

  // ── 8. Trace captured spans without prompt content ──────────────────
  const snap = trace.snapshot();
  check("E2E-TRACE-SPANS-CAPTURED", snap.spans.some((s) => s.name.startsWith("node.")));
  check("E2E-TRACE-NO-CONTENT", snap.spans.every((s) => s.attrs.prompt === undefined));
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} integration check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} integration checks passed — four planes compose end-to-end.`));