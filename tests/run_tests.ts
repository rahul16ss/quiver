/**
 * Quiver acceptance gate — CHECKER-OWNED.
 *
 * Per `.spec-swimlane.md`: QA is a checker concern. The maker (vendor) does
 * not ship a self-authored test suite; the maker may only raise genuine,
 * practical issues with meeting the QA criteria. The single source of truth
 * for acceptance is `tests/spec_acceptance_tests.ts`, which asserts against
 * the spec (not the vendor's shipped code).
 *
 * `npm test` exits non-zero while any contract check is unmet.
 */
import picocolors from "picocolors";
import { runSpecAcceptanceTests } from "./spec_acceptance_tests.js";
import { runHarnessTests } from "./harness/run.js";

async function main() {
  console.log(picocolors.cyan("\n🧪 Quiver — Spec Acceptance Gate (checker-owned)"));
  console.log("==================================================");
  const failures = await runSpecAcceptanceTests();
  if (failures > 0) {
    console.log(picocolors.red(`\n❌ ${failures} spec acceptance check(s) FAILED — vendor must fix before acceptance.`));
    process.exit(1);
  }
  console.log(picocolors.cyan("\n🎉 All spec acceptance checks passed.\n"));

  // Harness gate (refactor): narrow interfaces + concrete implementations.
  // Additive over the legacy spec gate; a failure here also fails `npm test`.
  const harnessFailures = await runHarnessTests();
  if (harnessFailures > 0) {
    console.log(picocolors.red(`\n❌ ${harnessFailures} harness check(s) FAILED.`));
    process.exit(1);
  }
  console.log(picocolors.cyan("\n🎉 All harness checks passed.\n"));
}

main().catch((err) => {
  console.error(picocolors.red("\n❌ Acceptance gate errored:"), err);
  process.exit(1);
});
