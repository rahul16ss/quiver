/**
 * ResearchGateway tests — Phase 3 (ADR-003).
 *
 * Mock-transport tests: policy gating, no regex fallback, query sanitization,
 * and consumption of the documented `excerpts`/`full_content` fields. Live
 * contract tests against real Parallel live in tests/harness/live/.
 */
import picocolors from "picocolors";
import { ParallelResearchGateway, type ParallelTransport } from "../../src/harness/research-gateway.js";
import { QuiverPolicyEngine } from "../../src/harness/policy-engine.js";
import { emptyPack } from "../../src/harness/customer-pack.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

class MockParallel implements ParallelTransport {
  lastSearch: any = null; lastExtract: any = null; lastTask: any = null; lastMonitor: any = null; lastFind: any = null;
  searchResults = { results: [{ url: "https://example.com/a", title: "A", publish_date: "2026-01-02", excerpts: ["excerpt A1"] }] };
  extractResults = { results: [{ url: "https://example.com/a", title: "A", publish_date: "2026-01-02", excerpts: ["ex A"], full_content: "# Full markdown" }] };
  async search(p: any) { this.lastSearch = p; return this.searchResults; }
  async extract(p: any) { this.lastExtract = p; return this.extractResults; }
  async taskRun(p: any) { this.lastTask = p; return { output: { type: "text", content: "answer", basis: [{ citations: [{ url: "https://example.com/a", title: "A", excerpts: ["ex A"] }] }] } }; }
  async monitor(p: any) { this.lastMonitor = p; return { monitor_id: "mon-1" }; }
  async monitorStop() {}
  async findEntities(p: any) { this.lastFind = p; return this.searchResults; }
}

const pack = emptyPack({ id: "acme" });
const policy = new QuiverPolicyEngine(pack);

async function run() {
  const t = new MockParallel();
  const gw = new ParallelResearchGateway(t, policy);

  // ── search consumes excerpts + provenance ───────────────────────────
  const results = await gw.search("apple earnings", { sensitivity: "public" });
  check("RESEARCH-SEARCH-RETURNS-EXCERPTS", results[0].excerpts.length === 1);
  check("RESEARCH-SEARCH-CANONICAL-URL", results[0].canonicalUrl === "https://example.com/a");
  check("RESEARCH-SEARCH-PUBLISHED-DATE", results[0].publishedDate === "2026-01-02");
  check("RESEARCH-SEARCH-RETRIEVED-AT", !!results[0].retrievedAt);
  check("RESEARCH-SEARCH-SOURCE-CATEGORY", results[0].sourceCategory === "public-web-research");

  // ── extract consumes excerpts + full_content (no result.content assumption) ─
  const ext = await gw.extract(["https://example.com/a"], { sensitivity: "public", objective: "revenue", fullContent: true });
  check("RESEARCH-EXTRACT-FULL-CONTENT", ext[0].fullContent === "# Full markdown");
  check("RESEARCH-EXTRACT-EXCERPTS", ext[0].excerpts.length === 1);
  check("RESEARCH-EXTRACT-SNAPSHOT-HASH", !!ext[0].snapshotHash);
  check("RESEARCH-EXTRACT-OBJECTIVE-PASSED", t.lastExtract.objective === "revenue");

  // ── research (Task) only for broad synthesis; citations preserved ───
  const task = await gw.research("synthesize Q1 sector trends", { sensitivity: "public", processor: "core" });
  check("RESEARCH-TASK-CONTENT", task.content === "answer");
  check("RESEARCH-TASK-CITATIONS", task.citations.length === 1 && task.citations[0].url === "https://example.com/a");

  // ── monitor ─────────────────────────────────────────────────────────
  const mon = await gw.monitor({ query: "competitor news", cadence: "daily", sensitivity: "public" });
  check("RESEARCH-MONITOR-HANDLE", mon.monitorId === "mon-1");

  // ── findEntities ────────────────────────────────────────────────────
  const ents = await gw.findEntities("fintech startups", { sensitivity: "public" });
  check("RESEARCH-FIND-ENTITIES", ents.length === 1);

  // ── confidential-internal sanitizes the query ──────────────────────
  const t2 = new MockParallel();
  const gw2 = new ParallelResearchGateway(t2, policy);
  await gw2.search("ACME client thesis on AAPL holdings", { sensitivity: "confidential-internal" });
  check("RESEARCH-CI-SANITIZES-QUERY", /redacted/i.test(t2.lastSearch.search_queries[0]) && !/thesis|client|holdings/i.test(t2.lastSearch.search_queries[0]));

  // ── restricted-mnpi refuses Parallel (no silent fallback) ───────────
  const mnpiPack = emptyPack({ id: "mnpi", sensitivityProfiles: [{ name: "restricted-mnpi", parallelAllowed: false, cloudInferenceAllowed: false, localRouteSlug: "local-1" }] });
  const mnpiPolicy = new QuiverPolicyEngine(mnpiPack);
  const mnpiGw = new ParallelResearchGateway(new MockParallel(), mnpiPolicy);
  let mnpiRefused = false;
  try { await mnpiGw.search("anything", { sensitivity: "restricted-mnpi" }); }
  catch (e) { mnpiRefused = /refused by policy/i.test((e as Error).message); }
  check("RESEARCH-MNPI-REFUSED", mnpiRefused);

  // ── no regex HTML scraping fallback path exists ────────────────────
  // The gateway has no 'direct' / htmlToText path. Assert the module exports
  // no scraping helper.
  const mod = await import("../../src/harness/research-gateway.js");
  check("RESEARCH-NO-REGEX-SCRAPER", !("htmlToText" in mod) && !("scrapeUrl" in mod));
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} research check(s) FAILED.`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} research checks passed.`));