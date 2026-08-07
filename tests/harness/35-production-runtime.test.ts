/**
 * ProductionRuntime wiring — proves the composition root constructs the real
 * surfaces (capability registry, broker, research-state, durable jobs,
 * deployment-profile tool filter) and never defaults to buildDemoEngine.
 */
import picocolors from "picocolors";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  const dataDir = path.join(os.tmpdir(), "q-prod-rt-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(dataDir, { recursive: true });

  const { config } = await import("../../src/config.js");
  const savedConfig = {
    or: config.openRouterApiKey,
    prof: config.openRouterModelProfile,
    url: config.llmBaseUrl,
    key: config.llmApiKey,
    parallel: config.parallelApiKey,
  };
  const savedProfile = process.env.QUIVER_DEPLOYMENT_PROFILE;

  try {
    // Clear mutable config (same technique as PRODUCTION-RUNTIME-HONEST-CONFIG-ERROR).
    config.openRouterApiKey = "";
    config.openRouterModelProfile = "";
    config.llmBaseUrl = "";
    config.llmApiKey = "";
    config.parallelApiKey = "";

    const { buildProductionRuntime, buildProductionEngine } = await import("../../src/harness/production-runtime.js");
    const { buildProductionEngine: launcherEngine } = await import("../../src/harness/launcher.js");

    let threw = false;
    try {
      await launcherEngine();
    } catch (err: any) {
      threw = /No model provider configured/i.test(String(err?.message || err));
    }
    check("PR-NO-MODEL-FAILS-CLOSED", threw);

    // ── Wiring-only runtime under air-gap ────────────────────────────
    process.env.QUIVER_DEPLOYMENT_PROFILE = "air-gapped";
    const rt = await buildProductionRuntime({ dataDir, allowMissingModel: true });
    check("PR-HAS-CAPABILITY-REGISTRY", !!rt.capabilities && typeof rt.capabilities.isCertified === "function");
    check("PR-HAS-BROKER", !!rt.broker && typeof rt.broker.list === "function");
    check("PR-HAS-RESEARCH-STATE", !!rt.researchState && typeof rt.researchState.asOf === "function");
    check("PR-HAS-JOBS", !!rt.jobs && typeof rt.jobs.upsert === "function");
    check("PR-HAS-IDEMPOTENCY", !!rt.idempotency && typeof rt.idempotency.alreadyProcessed === "function");
    check("PR-HAS-ARTIFACTS", !!rt.artifacts);
    check("PR-HAS-TRACES", !!rt.traces && rt.traces.redactsContent === true);
    check("PR-PROFILE-IS-AIR-GAPPED", rt.deploymentProfile === "air-gapped");
    check("PR-RESEARCH-NULL-WHEN-AIRGAPPED", rt.research === null);
    check("PR-UNAVAILABLE-LISTS-PARALLEL", rt.unavailable.some((u) => /parallel/i.test(u)));
    check("PR-UNAVAILABLE-LISTS-NETWORK-TOOLS", rt.unavailable.some((u) => /web_search|deep_research|scrape_url/.test(u)));
    check("PR-CTX-REMOVES-WEB-SEARCH", rt.executionContext.toolPermissions.removed.has("web_search"));
    check("PR-CTX-REMOVES-DEEP-RESEARCH", rt.executionContext.toolPermissions.removed.has("deep_research"));

    const { filterToolsByContext } = await import("../../src/security/execution_context.js");
    const filtered = filterToolsByContext(
      [{ name: "web_search" }, { name: "office_doc" }, { name: "deep_research" }],
      rt.executionContext,
    ).map((t) => t.name);
    check("PR-FILTER-DROPS-WEB", !filtered.includes("web_search"));
    check("PR-FILTER-KEEPS-OFFICE", filtered.includes("office_doc"));
    check("PR-FILTER-DROPS-DEEP", !filtered.includes("deep_research"));

    check(
      "PR-PDF-UNCERTIFIED-BY-DEFAULT",
      !rt.capabilities.isCertified(
        "openrouter",
        "https://openrouter.ai/api/v1",
        "anthropic/claude-sonnet-5",
        "quiver-harness",
        "application/pdf",
      ),
    );

    // buildProductionEngine alias returns the same kind of engine.
    const eng = await buildProductionEngine(undefined as any).catch(() => null);
    check("PR-ENGINE-ALIAS-FAILS-WITHOUT-MODEL", eng === null);

    const launcherSrc = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "../../src/harness/launcher.ts"),
      "utf8",
    );
    check("PR-DEMO-LABELLED", /DEMO ONLY/.test(launcherSrc));
    check("PR-STARTBROWSER-USES-RUNTIME", /buildProductionRuntime/.test(launcherSrc));
    check("PR-STARTBROWSER-NAMES-ENGINE", /startBrowserUI[\s\S]*?buildProductionEngine/.test(launcherSrc));
    check("PR-NO-PROD-CALL-DEMO", !/startBrowserUI[\s\S]*?buildDemoEngine\(/.test(launcherSrc));

    // connected-zdr without Parallel key reports unavailable honestly.
    process.env.QUIVER_DEPLOYMENT_PROFILE = "connected-zdr";
    const rt2 = await buildProductionRuntime({ dataDir: dataDir + "-2", allowMissingModel: true });
    check("PR-CONNECTED-NO-PARALLEL-KEY", rt2.research === null);
    check("PR-CONNECTED-UNAVAILABLE-PARALLEL", rt2.unavailable.some((u) => /PARALLEL_API_KEY/i.test(u)));
  } finally {
    config.openRouterApiKey = savedConfig.or;
    config.openRouterModelProfile = savedConfig.prof;
    config.llmBaseUrl = savedConfig.url;
    config.llmApiKey = savedConfig.key;
    config.parallelApiKey = savedConfig.parallel;
    if (savedProfile === undefined) delete process.env.QUIVER_DEPLOYMENT_PROFILE;
    else process.env.QUIVER_DEPLOYMENT_PROFILE = savedProfile;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dataDir + "-2", { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log();
  if (failed === 0) console.log(picocolors.green(`  ✔ ${passed} production-runtime checks passed.`));
  else {
    console.log(picocolors.red(`  ✗ ${failed} failed, ${passed} passed.`));
    for (const f of failures) console.log(picocolors.red(`    - ${f}`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
