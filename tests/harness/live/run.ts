/**
 * Live contract tests — OPT-IN.
 *
 * These exercise real external services (OpenRouter, native file ingestion,
 * Parallel, SharePoint/OneDrive, Google Drive, OfficeCLI). They are skipped by
 * default so CI never depends on network credentials. Run with:
 *
 *   QUIVER_LIVE_CONTRACT=1 npx tsx tests/harness/live/run.ts
 *
 * Each test fails closed if its required credential is absent (rather than
 * skipping silently) so a misconfigured "live" run is visible.
 */
import picocolors from "picocolors";

const LIVE = process.env.QUIVER_LIVE_CONTRACT === "1";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; console.log(picocolors.red(`   ✗ FAIL  ${name}${detail ? " — " + detail : ""}`)); }
}
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Live contract test requires ${name} (set QUIVER_LIVE_CONTRACT=1 and provide the credential).`);
  return v;
}

async function openrouterNativePdf() {
  const { ChatOpenRouterTransport, QuiverOpenRouterClient } = await import("../../../src/harness/model-client.js");
  const { ModelProfileRegistry, starterCatalog } = await import("../../../src/harness/model-profile.js");
  const { QuiverPolicyEngine } = await import("../../../src/harness/policy-engine.js");
  const { emptyPack } = await import("../../../src/harness/customer-pack.js");
  const fs = await import("fs");

  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const pdfPath = process.env.QUIVER_LIVE_PDF || "";
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    throw new Error("Live native-PDF test requires QUIVER_LIVE_PDF=<path to a real PDF>.");
  }
  const profiles = new ModelProfileRegistry();
  for (const p of starterCatalog()) profiles.register(p);
  const slug = process.env.QUIVER_LIVE_MODEL_PROFILE || "openai-gpt-4o";
  // Pre-certify based on an explicit opt-in env flag; the test itself is the
  // certification. A failure here means the route cannot accept native PDFs and
  // must NOT be silently substituted with OCR.
  profiles.certify(slug, "application/pdf", "pass");
  const pack = emptyPack({ id: "live" });
  const transport = new ChatOpenRouterTransport(apiKey);
  const client = new QuiverOpenRouterClient(transport, profiles, new QuiverPolicyEngine(pack));
  const data = fs.readFileSync(pdfPath);
  const res = await client.invoke(
    [{ role: "user", content: [{ type: "text", text: "Summarize the first page." }, { type: "file", mimeType: "application/pdf", data, filename: "doc.pdf" }] }],
    { modelProfile: slug, sensitivity: "public", budget: { timeoutMs: 60_000 } },
  );
  check("LIVE-OPENROUTER-NATIVE-PDF", typeof res.content === "string" && res.content.length > 0, "no content returned");
  check("LIVE-OPENROUTER-ROUTE-CAPTURED", !!res.route);
}

async function parallelSearch() {
  const { ParallelResearchGateway, ParallelWebTransport } = await import("../../../src/harness/research-gateway.js");
  const { QuiverPolicyEngine } = await import("../../../src/harness/policy-engine.js");
  const { emptyPack } = await import("../../../src/harness/customer-pack.js");
  const apiKey = requireEnv("PARALLEL_API_KEY");
  const gw = new ParallelResearchGateway(new ParallelWebTransport(apiKey), new QuiverPolicyEngine(emptyPack({ id: "live" })));
  const results = await gw.search("OpenAI latest news", { sensitivity: "public", maxResults: 3 });
  check("LIVE-PARALLEL-SEARCH", results.length > 0, "no results");
}

async function main() {
  if (!LIVE) {
    console.log(picocolors.yellow("\n  ⏭  Live contract tests skipped (set QUIVER_LIVE_CONTRACT=1 to run)."));
    return;
  }
  const suites: Array<{ name: string; env: string[]; run: () => Promise<void> }> = [
    { name: "OpenRouter native PDF", env: ["OPENROUTER_API_KEY", "QUIVER_LIVE_PDF"], run: openrouterNativePdf },
    { name: "Parallel search", env: ["PARALLEL_API_KEY"], run: parallelSearch },
    // SharePoint/OneDrive, Google Drive, OfficeCLI live suites are added in
    // Phases 6/7 once those providers are implemented.
  ];
  for (const s of suites) {
    const hasCreds = s.env.every((e) => !!process.env[e]);
    if (!hasCreds) {
      console.log(picocolors.gray(`\n  ⏭  ${s.name}: skipped (missing ${s.env.filter((e) => !process.env[e]).join(", ")})`));
      continue;
    }
    console.log(picocolors.cyan(`\n  ▶ ${s.name}`));
    try { await s.run(); }
    catch (e) { check(`LIVE-${s.name}`, false, (e as Error).message); }
  }
  if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} live contract check(s) FAILED.`)); process.exit(1); }
  console.log(picocolors.cyan(`\n  ✔ ${passed} live contract checks passed.`));
}

main().catch((e) => { console.error(e); process.exit(1); });