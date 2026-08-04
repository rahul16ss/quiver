/**
 * Quiver e2e runner — Tier A (offline), B (officecli), C/D (live).
 *
 * Usage:
 *   npx tsx tests/e2e/run_e2e.ts
 *   npx tsx tests/e2e/run_e2e.ts --tier=a
 *   npx tsx tests/e2e/run_e2e.ts --tier=a,b
 *   npx tsx tests/e2e/run_e2e.ts --tier=all
 */
import { runTierA } from "./tier_a_offline.js";
import { runTierB } from "./tier_b_officecli.js";
import { runTierCD } from "./tier_cd_live.js";
import type { E2eReporter } from "./helpers.js";

function parseTiers(): Set<string> {
  const arg = process.argv.find((a) => a.startsWith("--tier="));
  const raw = (arg?.split("=")[1] || "a,b").toLowerCase();
  if (raw === "all") return new Set(["a", "b", "c", "d"]);
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function main() {
  const tiers = parseTiers();
  const reporters: E2eReporter[] = [];

  if (tiers.has("a")) reporters.push(await runTierA());
  if (tiers.has("b")) reporters.push(await runTierB());
  if (tiers.has("c") || tiers.has("d")) reporters.push(await runTierCD());

  let passed = 0;
  let failed = 0;
  for (const r of reporters) {
    const s = r.summary();
    passed += s.passed;
    failed += s.failed;
  }
  console.log(`\n══ E2E total: ${passed} passed, ${failed} failed ══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
