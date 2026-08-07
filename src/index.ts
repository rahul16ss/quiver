/**
 * Quiver public library surface.
 *
 * Everything exported here is covered by the stability contract in
 * docs/STABILITY.md (semver-governed). Everything NOT exported here is
 * internal and may change without notice. If you are integrating Quiver as a
 * library, import from this module — never from deep `src/**` paths.
 *
 * The primary product surface remains the `quiver` CLI + loopback browser UI;
 * this module is the programmatic seam for customer solutions built on the
 * same control plane.
 */

// ─── Control plane ────────────────────────────────────────────────────
export { QuiverExecutionEngine } from "./harness/execution-engine.js";
export type { ToolExecutor, ToolResult, TurnExecutor, TurnIo } from "./harness/execution-engine.js";
export type {
  ExecutionEngine,
  RunOptions,
  RunOutcome,
  RunSnapshot,
  PendingApproval,
  GapEntry,
  ModelClient,
  ModelMessage,
  ModelResult,
  ModelUsage,
  RequestBudget,
  ContentPart,
  SensitivityProfile,
  SourceCategory,
} from "./harness/interfaces.js";
export { ALL_SOURCE_CATEGORIES } from "./harness/interfaces.js";
export { GapLedger, initialLedger, evaluateCompletion } from "./harness/goal-contract.js";
export type { GoalContract, DeliverableSpec, FanOutSpec } from "./harness/goal-contract.js";

// ─── Composition root ─────────────────────────────────────────────────
export {
  buildProductionRuntime,
  buildProductionEngine,
  resolveProductionPack,
} from "./harness/production-runtime.js";
export type { ProductionRuntime } from "./harness/production-runtime.js";

// ─── Model routing + evidence ─────────────────────────────────────────
export { ModalityRouter, AUTO_PROFILE, classifyModality } from "./harness/model-router.js";
export type { ModelRole, MessageModality } from "./harness/model-router.js";
export {
  ModelProfileRegistry,
  starterCatalog,
  applyApprovedModels,
  isCertifiedFor,
} from "./harness/model-profile.js";
export type { ModelProfile } from "./harness/model-profile.js";
export { CapabilityRegistry } from "./harness/capability-registry.js";
export {
  RoutingEvidenceStore,
  runEvalSuite,
  computeParetoFrontier,
  measuredPreference,
} from "./harness/routing-eval.js";
export type { EvalTask, EvalResult, ParetoPoint } from "./harness/routing-eval.js";

// ─── Batch execution + cost accounting ────────────────────────────────
export { runFanOut } from "./harness/fanout.js";
export type { FanOutProgress, FanOutResult } from "./harness/fanout.js";
export { CostLedger } from "./harness/cost-ledger.js";
export type { CostEntry, BudgetVerdict } from "./harness/cost-ledger.js";

// ─── Policy + customer packs ──────────────────────────────────────────
export { QuiverPolicyEngine } from "./harness/policy-engine.js";
export { CustomerPackRegistry, emptyPack } from "./harness/customer-pack.js";
export type { CustomerPack } from "./harness/customer-pack.js";

// ─── Workflow specs (the twelve reference scenarios) ──────────────────
export { TWELVE_WORKFLOW_SPECS } from "./harness/workflow-spec.js";
export type { WorkflowSpec } from "./harness/workflow-spec.js";

// ─── Evidence + lineage primitives ────────────────────────────────────
export { EvidenceTracker } from "./evidence/tracker.js";
export type { SourceRecord, ClaimRecord, EvidenceModel } from "./evidence/model.js";
