/**
 * §18 — 12-workflow LIVE-ENGINE acceptance matrix.
 *
 * Unlike 08 (which asserts acceptance checks against hand-built run RECORDS),
 * this drives the REAL QuiverExecutionEngine goal-loop for every one of the 12
 * reference workflows and proves the engine actually executes each workflow:
 * the contract is built from the WorkflowSpec, the engine runs the plan phase
 * (which now calls the maker model), executes tool steps, runs the independent
 * checker, and pauses at the human-approval gate — never a false "completed"
 * and never a hung/failed run for a well-formed spec. Deterministic (mock
 * model + mock tools); no network.
 */
import picocolors from "picocolors";
import * as path from "path";
import * as os from "os";
import type { GoalContract } from "../../src/harness/goal-contract.js";
import type { ModelClient, ModelMessage, ModelProfileRef, ModelResult } from "../../src/harness/interfaces.js";
import { QuiverExecutionEngine, type ToolExecutor, type ToolResult } from "../../src/harness/execution-engine.js";
import { SqliteCheckpointSaver } from "../../src/harness/sqlite-checkpoint.js";
import { LocalTraceSink } from "../../src/harness/trace-sink.js";
import { TWELVE_WORKFLOW_SPECS, type WorkflowSpec } from "../../src/harness/workflow-spec.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
	if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
	else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

// ── Deterministic mock model (records roles; maker → plan, checker → OK) ──
class MockModel implements ModelClient {
	id = "mock"; kind = "local" as const;
	roles: string[] = [];
	constructor(private planContent = "1. gather evidence\n2. analyze\n3. produce deliverable\n4. verify\n") {}
	listProfiles(): ModelProfileRef[] { return [{ slug: "local-private-default", label: "local", providerOrder: ["Local"], zdrEligible: true, checkerEligible: true }]; }
	async invoke(messages: ModelMessage[], options?: { role?: string }): Promise<ModelResult> {
		if (options?.role) this.roles.push(options.role);
		const last = messages[messages.length - 1];
		const content = typeof last.content === "string" ? last.content : "";
		return {
			content: /checker/i.test(content) ? "OK" : this.planContent,
			modelProfile: "local-private-default", route: "local",
		};
	}
}

class MockTools implements ToolExecutor {
	available() { return ["office_doc", "evidence", "deep_research"]; }
	async call(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
		return { ok: true, output: `${toolName}:${args.step}`, evidenceRefs: [`evidence-${args.step}`] };
	}
}

function contractFromSpec(spec: WorkflowSpec): GoalContract {
	return {
		runId: `RUN-${spec.number}-${Math.random().toString(36).slice(2, 8)}`,
		objective: `${spec.name}: ${spec.deliverable.type} across ${spec.requiredSourceCategories.join(", ")}`,
		requiredDeliverables: [{ type: spec.deliverable.type as any, mimeType: spec.deliverable.mimeType, sections: spec.deliverable.sections }],
		definitionOfDone: ["sources resolved", "deliverable produced", "checker passed"],
		requiredSourceCategories: spec.requiredSourceCategories,
		dataSensitivity: spec.dataSensitivity,
		reviewer: spec.reviewer,
		budgets: { iterations: 6, timeMs: 60_000, costUsd: 10 },
		stopConditions: ["budget exhausted"],
		createdAt: new Date().toISOString(),
	};
}

function newSaver(): SqliteCheckpointSaver {
	const dir = path.join(os.tmpdir(), "quiver-live-" + Math.random().toString(36).slice(2));
	return new SqliteCheckpointSaver(path.join(dir, "ckpt.db"));
}

async function run() {
	check("LW-SCENARIOS-TWELVE", TWELVE_WORKFLOW_SPECS.length === 12);
	for (const spec of TWELVE_WORKFLOW_SPECS) {
		const model = new MockModel();
		const engine = new QuiverExecutionEngine(newSaver(), model, new MockTools(), { maxIterations: 6 });
		const outcome = await engine.run(contractFromSpec(spec), { trace: new LocalTraceSink() } as any);
		const tag = `LW-${spec.number}-${spec.id}`;
		// A well-formed workflow reaches the human-approval pause (honest
		// terminal for a mock run), not a false completed, not failed/blocked.
		check(`${tag}-ENGINE-RAN`, outcome.status !== "failed" && outcome.status !== "cancelled", `status=${outcome.status}`);
		check(`${tag}-PRODUCED-PLAN`, model.roles.includes("maker"), `maker calls=${model.roles.filter((r) => r === "maker").length}`);
		check(`${tag}-CHECKER-RAN`, model.roles.includes("checker"), `checker calls=${model.roles.filter((r) => r === "checker").length}`);
		check(`${tag}-MAKER-CHECKER-SEPARATE`, model.roles.includes("maker") && model.roles.includes("checker"));
		// Honest terminal: approval gate (paused) OR truthful partial with the
		// unresolved items stated — NEVER a false "completed" for a mock that
		// cannot physically satisfy every workflow's acceptance criteria.
		check(`${tag}-HONEST-TERMINAL`, outcome.status === "paused" || outcome.status === "partial", `status=${outcome.status}`);
		check(`${tag}-NO-FALSE-COMPLETED`, outcome.status !== "completed", `status=${outcome.status}`);
		check(`${tag}-RUN-RECORD`, !!outcome.runRecord && typeof outcome.runRecord === "object");
	}

	// Maker and checker must both be dispatched across the matrix (the engine
	// routes the maker via AUTO_PROFILE, not just the checker).
	const allRoles = new Set<string>();
	for (const spec of TWELVE_WORKFLOW_SPECS) {
		const model = new MockModel();
		const engine = new QuiverExecutionEngine(newSaver(), model, new MockTools(), { maxIterations: 6 });
		await engine.run(contractFromSpec(spec), { trace: new LocalTraceSink() } as any);
		model.roles.forEach((r) => allRoles.add(r));
	}
	check("LW-MATRIX-MAKER-ROUTED", allRoles.has("maker"));
	check("LW-MATRIX-CHECKER-ROUTED", allRoles.has("checker"));
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} live-engine check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} live-engine workflow checks passed.`));
