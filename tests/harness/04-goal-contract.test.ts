/**
 * GoalContract + GapLedger tests — Phase 4 (ADR-002).
 */
import picocolors from "picocolors";
import { GapLedger, initialLedger, evaluateCompletion, type GoalContract } from "../../src/harness/goal-contract.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

const contract: GoalContract = {
  runId: "RUN-1",
  objective: "IC memo",
  requiredDeliverables: [{ type: "memo", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["summary"] }],
  definitionOfDone: ["all figures sourced", "checker passed", "human approved"],
  requiredSourceCategories: ["filings-ir", "market-data-estimates"],
  dataSensitivity: "public",
  reviewer: "jane",
  budgets: { iterations: 5 },
  stopConditions: ["budget exhausted"],
  createdAt: new Date().toISOString(),
};

const ledger = initialLedger(contract);
check("GOAL-INIT-LEDGER-HAS-SOURCES", ledger.all().some((e) => e.category === "filings-ir"));
check("GOAL-INIT-LEDGER-HAS-DELIVERABLE", ledger.all().some((e) => e.category === "deliverable"));
check("GOAL-INIT-LEDGER-HAS-APPROVAL", ledger.all().some((e) => e.category === "approval"));

// Not complete while gaps open.
const partial = evaluateCompletion(contract, ledger, [{ id: "dod-1", pass: true, detail: "ok" }]);
check("GOAL-PARTIAL-WHEN-GAPS-OPEN", partial.status === "partial" && partial.unresolved.length > 0);

// Resolve all gaps + all checks pass → completed.
for (const e of ledger.all()) ledger.resolve(e.id);
const done = evaluateCompletion(contract, ledger, [
  { id: "dod-1", pass: true, detail: "all figures sourced" },
  { id: "dod-2", pass: true, detail: "checker passed" },
  { id: "dod-3", pass: true, detail: "human approved" },
]);
check("GOAL-COMPLETED-WHEN-ALL-PASS", done.status === "completed" && done.unresolved.length === 0);

// A failed check is never a successful completion.
const failedCheck = evaluateCompletion(contract, ledger, [{ id: "dod-1", pass: false, detail: "evidence missing" }]);
check("GOAL-FAILED-CHECK-IS-PARTIAL", failedCheck.status === "partial" && /evidence missing/.test(failedCheck.unresolved.join(" ")));

// Blocked gap → blocked status with honest reason.
const blockedLedger = new GapLedger();
blockedLedger.add("missing entitlement", "market-data-estimates");
blockedLedger.block(blockedLedger.all()[0].id, "no connector for market-data-estimates");
const blocked = evaluateCompletion(contract, blockedLedger, []);
check("GOAL-BLOCKED-WHEN-BLOCKED-GAP", blocked.status === "blocked" && /blocked/i.test(blocked.stopReason));

if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} goal check(s) FAILED.`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} goal checks passed.`));