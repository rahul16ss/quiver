/**
 * Twelve workflow capability scenarios — Phase 9 acceptance (ADR-007).
 *
 * HONEST SCOPE: this file tests the GENERIC harness *acceptance-check
 * predicates* and catalog structure against fixture run records
 * (`passingRunRecord` / `failingRunRecord`). It does NOT execute the
 * production engine. Live engine execution of all twelve specs is covered by
 * `28-workflow-live-engine.test.ts` (mock model/tools, real goal loop).
 * Credential-free document demos remain the three demo-ready packs.
 *
 * Each scenario is a declarative WorkflowSpec; the harness evaluates the
 * spec's acceptance checks against synthetic run records (positive + negative)
 * and verifies the generic invariants: context/source selection, sensitivity
 * enforcement, no licensed-data substitution, native Office output,
 * formula/layout preservation, evidence locators, maker/checker separation,
 * human approval before commit, storage conflict behavior, reproducibility.
 */
import picocolors from "picocolors";
import { TWELVE_WORKFLOW_SPECS, passingRunRecord, failingRunRecord, type WorkflowSpec } from "../../src/harness/workflow-spec.js";
import { ALL_SOURCE_CATEGORIES } from "../../src/harness/interfaces.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

// ── Structural validation of the spec catalog itself ──────────────────

check("SCENARIOS-COUNT-IS-TWELVE", TWELVE_WORKFLOW_SPECS.length === 12);
check("SCENARIOS-NUMBERED-1-12", TWELVE_WORKFLOW_SPECS.every((s, i) => s.number === i + 1));
check("SCENARIOS-IDS-UNIQUE", new Set(TWELVE_WORKFLOW_SPECS.map((s) => s.id)).size === 12);
check("SCENARIOS-INPUTS-SYNTHETIC-ONLY", TWELVE_WORKFLOW_SPECS.every((s) => s.inputs.every((i) => i.synthetic === true)));
check("SCENARIOS-SOURCE-CATEGORIES-VALID", TWELVE_WORKFLOW_SPECS.every((s) => s.requiredSourceCategories.every((c) => ALL_SOURCE_CATEGORIES.includes(c))));
check("SCENARIOS-HAVE-REVIEWER", TWELVE_WORKFLOW_SPECS.every((s) => !!s.reviewer));
check("SCENARIOS-HAVE-ACCEPTANCE-CHECKS", TWELVE_WORKFLOW_SPECS.every((s) => s.acceptanceChecks.length >= 9));

// Each spec names its licensed no-substitute categories (open web never silently
// stands in for consensus/estimates/prices/holdings/risk).
check("SCENARIOS-LICENSED-CATEGORIES-NAMED", TWELVE_WORKFLOW_SPECS.filter((s) => s.requiredSourceCategories.includes("market-data-estimates")).every((s) => s.noSubstituteCategories.includes("market-data-estimates")));

// ── Per-scenario: positive run passes every acceptance check ──────────

for (const spec of TWELVE_WORKFLOW_SPECS) {
  const record = passingRunRecord(spec);
  const results = spec.acceptanceChecks.map((c) => ({ id: c.id, pass: c.assert(record) }));
  const allPass = results.every((r) => r.pass);
  check(`SCENARIO-${spec.number}-${spec.id}-POSITIVE`, allPass, results.filter((r) => !r.pass).map((r) => r.id).join(","));
  // Required source categories resolved (no silent gaps).
  check(`SCENARIO-${spec.number}-${spec.id}-SOURCES-RESOLVED`, record.sourcesSelected.length === spec.requiredSourceCategories.length);
  // Native Office output MIME matches the deliverable.
  check(`SCENARIO-${spec.number}-${spec.id}-NATIVE-OFFICE-MIME`, record.deliverableMimeType === spec.deliverable.mimeType);
  // Formula/layout preservation asserted for spreadsheet deliverables.
  if (spec.deliverable.mimeType.includes("spreadsheetml")) {
    check(`SCENARIO-${spec.number}-${spec.id}-FORMULA-LAYOUT`, record.formulaLayoutPreserved);
  }
}

// ── Per-scenario: negative runs are caught by the relevant invariant ──

for (const spec of TWELVE_WORKFLOW_SPECS) {
  // Substitution of licensed data with open web must fail no-licensed-substitution.
  const sub = failingRunRecord(spec, "substitution");
  const subCheck = spec.acceptanceChecks.find((c) => c.id === "no-licensed-substitution")!;
  check(`SCENARIO-${spec.number}-${spec.id}-CATCHES-SUBSTITUTION`, !subCheck.assert(sub));

  // Missing human approval must fail the human-approval check.
  const noApp = failingRunRecord(spec, "no-approval");
  const appCheck = spec.acceptanceChecks.find((c) => c.id === "human-approval")!;
  check(`SCENARIO-${spec.number}-${spec.id}-CATCHES-NO-APPROVAL`, !appCheck.assert(noApp));

  // Wrong output MIME must fail native-office-output.
  const wrongMime = failingRunRecord(spec, "wrong-mime");
  const mimeCheck = spec.acceptanceChecks.find((c) => c.id === "native-office-output")!;
  check(`SCENARIO-${spec.number}-${spec.id}-CATCHES-WRONG-MIME`, !mimeCheck.assert(wrongMime));

  // No evidence must fail evidence-locators.
  const noEv = failingRunRecord(spec, "no-evidence");
  const evCheck = spec.acceptanceChecks.find((c) => c.id === "evidence-locators")!;
  check(`SCENARIO-${spec.number}-${spec.id}-CATCHES-NO-EVIDENCE`, !evCheck.assert(noEv));
}

// ── Sensitivity policy: MNPI scenarios route to local (no cloud/Parallel) ─
// None of the twelve fixtures carry MNPI (all synthetic/public or
// confidential-internal), but the harness must enforce the boundary. The
// confidential-internal scenarios must not send internal thesis to Parallel.
const ciScenarios = TWELVE_WORKFLOW_SPECS.filter((s) => s.dataSensitivity === "confidential-internal");
check("SCENARIOS-CONFIDENTIAL-INTERNAL-COUNT", ciScenarios.length >= 4);
check("SCENARIOS-NO-MNPI-FIXTURES", TWELVE_WORKFLOW_SPECS.every((s) => s.dataSensitivity !== "restricted-mnpi"));

if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} scenario check(s) FAILED:\n${failures.slice(0, 20).join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} scenario checks passed across all twelve reference workflows.`));