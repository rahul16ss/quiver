#!/usr/bin/env node
/**
 * Routing-eval runner.
 *
 * Default (offline): runs the starter suite against a scripted mock client so
 * the harness math (rubrics, Pareto, store, router preference) is exercised
 * deterministically with no credentials and no network.
 *
 * Live: `QUIVER_LIVE_EVAL=1 npx tsx scripts/run_routing_eval.ts` uses the
 * production OpenRouter client and writes real evidence to
 * ~/.quiver/routing-evidence.json (or QUIVER_EVAL_OUT). Live runs cost money.
 */
import * as os from "os";
import * as path from "path";
import {
  buildSnapshot,
  measuredPreference,
  RoutingEvidenceStore,
  runEvalSuite,
} from "../src/harness/routing-eval.js";
import { STARTER_EVAL_TASKS } from "../src/harness/eval-tasks.js";

async function main(): Promise<void> {
  const live = process.env.QUIVER_LIVE_EVAL === "1";
  const outPath =
    process.env.QUIVER_EVAL_OUT ?? path.join(os.homedir(), ".quiver", "routing-evidence.json");

  let client: import("../src/harness/interfaces.js").ModelClient;
  let profileSlugs: string[];

  if (live) {
    const { buildProductionRuntime } = await import("../src/harness/production-runtime.js");
    const runtime = await buildProductionRuntime();
    // The runtime's model client is internal to the engine; construct the
    // client directly for explicit-profile evaluation.
    const { config } = await import("../src/config.js");
    // Parent-env key wins for this dev script (same semantics as config.ts's
    // dotenv handling): a stale keychain entry must not shadow an explicitly
    // exported key when running evals.
    const apiKey = process.env.OPENROUTER_API_KEY || config.openRouterApiKey;
    if (!apiKey) throw new Error("QUIVER_LIVE_EVAL=1 requires OPENROUTER_API_KEY");
    const { ChatOpenRouterTransport, QuiverOpenRouterClient } =
      await import("../src/harness/model-client.js");
    const { QuiverPolicyEngine } = await import("../src/harness/policy-engine.js");
    const { emptyPack } = await import("../src/harness/customer-pack.js");
    const transport = new ChatOpenRouterTransport(apiKey, {
      siteUrl: "https://convictionstudio.com",
      siteName: "Quiver routing eval",
    });
    client = new QuiverOpenRouterClient(
      transport,
      runtime.profiles,
      new QuiverPolicyEngine(emptyPack()),
    );
    profileSlugs = runtime.profiles
      .list()
      .filter((p) => p.zdrEligible && !p.modelSlug.startsWith("local/"))
      .map((p) => p.slug);
  } else {
    // Scripted mock: quality varies by profile so the Pareto math is real.
    // "cheap-good" should dominate "cheap-bad"; "expensive-great" should be
    // Pareto-optimal but lose the measured preference to a cheaper qualified
    // profile.
    const behavior: Record<string, { quality: "good" | "bad"; cost: number }> = {
      "cheap-good": { quality: "good", cost: 0.001 },
      "cheap-bad": { quality: "bad", cost: 0.0005 },
      "expensive-great": { quality: "good", cost: 0.02 },
    };
    client = {
      id: "mock",
      kind: "local",
      listProfiles: () => [],
      invoke: async (messages, options) => {
        const b = behavior[options.modelProfile] ?? { quality: "bad", cost: 0.001 };
        const text = Array.isArray(messages[0]?.content)
          ? ((messages[0].content as any[]).find((p) => p.type === "text")?.text ?? "")
          : String(messages[0]?.content ?? "");
        const goodAnswer = (() => {
          if (/attached PDF/.test(text)) return "Revenue: $48.2 million; EBITDA margin: 22.4%.";
          if (/EBITDA margin and net leverage/.test(text))
            return "EBITDA margin 22.4%; net leverage 3.4x.";
          if (/Fiscal Q2 revenue|filing excerpt/i.test(text) && /revenue/i.test(text)) {
            return "Q2 revenue was $48.2 million (up 17.8% YoY).";
          }
          if (/draft claims: "Revenue grew 31%/.test(text))
            return "FLAG — unsupported by the source.";
          if (/draft claims: "Q2 revenue was \$48\.2/.test(text)) return "OK";
          if (/two-sentence investment-committee/.test(text))
            return "Revenue was $48.2 million in Q2, up 17.8% year-over-year. EBITDA margin was 22.4%.";
          if (/Source A says/.test(text))
            return "Use $48.2 million — the company filing is the authoritative primary source.";
          return "";
        })();
        const content = b.quality === "good" ? goodAnswer : "I cannot determine this.";
        return {
          content,
          route: "mock",
          modelProfile: options.modelProfile,
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, costUsd: b.cost },
        };
      },
    } as any;
    profileSlugs = Object.keys(behavior);
  }

  const results = await runEvalSuite(client, profileSlugs, STARTER_EVAL_TASKS);
  const snapshot = buildSnapshot(STARTER_EVAL_TASKS, results);
  const store = new RoutingEvidenceStore(outPath);
  store.save(snapshot);

  console.log(`suite: ${STARTER_EVAL_TASKS.length} tasks × ${profileSlugs.length} profiles`);
  console.log(`evidence written: ${outPath}`);
  console.log("pareto frontier:");
  for (const p of snapshot.frontier) {
    console.log(
      `  ${p.paretoOptimal ? "★" : " "} ${p.role}/${p.modality} ${p.profileSlug} ` +
        `quality=${p.meanQuality.toFixed(2)} cost=${p.meanCostUsd ?? "?"} tasks=${p.tasks}`,
    );
  }
  const pref = measuredPreference(snapshot, "maker", "text-only");
  console.log(`measured preference (maker, text-only): ${pref ?? "none — static order applies"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
