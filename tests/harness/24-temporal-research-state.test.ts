/**
 * ResearchStateStore / TemporalEvidenceGraph — behavioral tests (§13).
 *
 * Critical invariant: a point-in-time (as-of) query must NOT leak future
 * information — a claim version recorded after the as-of date is excluded
 * even if its validTime is before. Also: non-destructive versioning,
 * supersession, contradiction marking, changes-between, based-on-available-
 * evidence, unverified hypotheses stay hypotheses.
 */
import picocolors from "picocolors";
import { ResearchStateStore, type ClaimVersion } from "../../src/harness/research-state-store.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  const store = new ResearchStateStore();

  // ── record a claim v1 (valid 2024-Q1, recorded 2024-02-01) ──
  store.recordClaim({
    claimId: "aapl-revenue-q1", validTime: "2024-03-31", recordedTime: "2024-02-01T00:00:00Z",
    kind: "guidance", claim: "Apple Q1 revenue guidance", value: { value: 90, currency: "USD", scale: "billions" },
    status: "sourced", source: { category: "filings-ir" as any, source: "Apple IR", locator: "8-K", retrievedAt: "2024-02-01" },
    sensitivity: "public",
  });
  check("RECORD-V1", store.latest("aapl-revenue-q1")?.version === 1);

  // ── record v2 (actual, recorded 2024-05-02) supersedes v1 ──
  store.recordClaim({
    claimId: "aapl-revenue-q1", validTime: "2024-03-31", recordedTime: "2024-05-02T00:00:00Z",
    kind: "actual", claim: "Apple Q1 revenue actual", value: { value: 95, currency: "USD", scale: "billions" },
    status: "sourced", source: { category: "filings-ir" as any, source: "10-Q", locator: "10-Q", retrievedAt: "2024-05-02" },
    sensitivity: "public",
  });
  const hist = store.history("aapl-revenue-q1");
  check("RECORD-V2-SUPERSEDES", hist.length === 2 && hist[1].supersedes === 1);
  // v1 is marked contradicted (guidance 90 vs actual 95).
  check("V1-CONTRADICTED", hist[0].contradictedBy === 2, "guidance superseded by differing actual must be marked contradicted");
  check("LATEST-IS-V2", store.latest("aapl-revenue-q1")?.kind === "actual");

  // ── NON-DESTRUCTIVE: v1 is unchanged after v2 ──
  check("NON-DESTRUCTIVE", hist[0].version === 1 && hist[0].claim === "Apple Q1 revenue guidance" && hist[0].value?.value === 90);

  // ── POINT-IN-TIME: as of 2024-03-01 (before v2 recorded) → returns v1, not v2 ──
  const asOfMar = store.asOf("aapl-revenue-q1", "2024-03-01T00:00:00Z");
  check("ASOF-PRE-V2-RETURNS-V1", asOfMar?.version === 1 && asOfMar?.value?.value === 90);
  // ── NO FUTURE LEAKAGE: as of 2024-03-01 must NOT return v2 (recorded 2024-05) ──
  check("ASOF-NO-FUTURE-LEAKAGE", asOfMar?.kind !== "actual", "v2 recorded after as-of date must not leak in");

  // as of 2024-06-01 → returns v2.
  const asOfJun = store.asOf("aapl-revenue-q1", "2024-06-01T00:00:00Z");
  check("ASOF-POST-V2-RETURNS-V2", asOfJun?.version === 2 && asOfJun?.value?.value === 95);

  // ── as of before any recording → null (no leakage of unknown future) ──
  check("ASOF-BEFORE-ANY-NULL", store.asOf("aapl-revenue-q1", "2023-01-01T00:00:00Z") === null);

  // ── changes-between ──
  const changes = store.changesBetween("aapl-revenue-q1", "2024-02-01T00:00:00Z", "2024-06-01T00:00:00Z");
  check("CHANGES-BETWEEN", changes.length === 1 && changes[0].version === 2);

  // ── based-on-available-evidence: a conclusion on 2024-04-01 could not use v2 ──
  // evidenceClaimIds = [aapl-revenue-q1]; conclusionDate 2024-04-01 → v2 not known yet, but v1 is.
  check("BASED-ON-AVAILABLE-V1-OK", store.basedOnAvailableEvidence("aapl-revenue-q1", "2024-04-01T00:00:00Z", ["aapl-revenue-q1"]) === true);
  // A conclusion on 2024-04-01 that claims to use a DIFFERENT claim recorded later → false.
  store.recordClaim({
    claimId: "aapl-eps-q1", validTime: "2024-03-31", recordedTime: "2024-05-10T00:00:00Z",
    kind: "actual", claim: "EPS", value: { value: 1.5, currency: "USD", scale: "absolute" },
    status: "sourced", source: { category: "filings-ir" as any, source: "10-Q", locator: "10-Q", retrievedAt: "2024-05-10" },
    sensitivity: "public",
  });
  check("BASED-ON-AVAILABLE-FUTURE-EVIDENCE-REJECTED",
    store.basedOnAvailableEvidence("x", "2024-04-01T00:00:00Z", ["aapl-eps-q1"]) === false,
    "a conclusion on 2024-04-01 cannot rely on evidence recorded 2024-05-10");

  // ── edges: unverified hypotheses stay hypotheses ──
  store.addEdge({ id: "e1", kind: "supplier-customer", from: "AAPL", to: "TSM", verified: true, evidence: ["10-K"], recordedTime: "2024-01-01" });
  store.addEdge({ id: "e2", kind: "competitor-peer", from: "AAPL", to: "GOOG", verified: false, recordedTime: "2024-02-01" });
  check("EDGE-HYPOTHESES-ISOLATED", store.hypotheses().length === 1 && store.hypotheses()[0].id === "e2");
  check("EDGE-FROM-TRAVERSAL", store.edgesFrom("AAPL").length === 2);
  // An unverified edge is NOT treated as a fact in the edge list of verified.
  check("EDGE-VERIFIED-FILTER", store.edgesFrom("AAPL").filter((e) => e.verified).length === 1);

  // ── export is a detached snapshot ──
  const snap = store.export();
  check("EXPORT-DETACHED", snap.claims.length === 2 && snap.edges.length === 2);

  console.log(failed === 0
    ? picocolors.green(`\n   ✔ All ${passed} temporal-research-state checks passed`)
    : picocolors.red(`\n   ✗ ${failed}/${passed + failed} checks FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
