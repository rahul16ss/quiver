/**
 * Workflow Orchestrator — state machine executor for workflow packs.
 *
 * Loads a WorkflowDefinition, steps through phases
 * (discover → map → build → verify → train → handover), persists
 * checkpoint state in `.quiver/workflow-runs/`, emits events for the
 * daemon SSE stream, and integrates drift detection before the `build`
 * phase.
 *
 * This is the backbone of ambient AI: the orchestrator takes a declarative
 * workflow.yaml and executes it as a stateful, observable pipeline with
 * human-in-the-loop review gates.
 *
 * SPEC §12 / §19 Build Order #7.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowPhase,
  PhaseResult,
  WorkflowEvent,
  WorkflowEventType,
} from "./types.js";
import { PHASE_ORDER } from "./types.js";
import { findBinary } from "../utils/find_binary.js";
import type {
  ClaimRecord,
  ExcelCellVerification,
  ExcelDerivedVerification,
  EvidenceModel,
} from "../evidence/model.js";
import { loadExpectedStructure, checkDrift, type DriftResult } from "./drift.js";
import { atomicWriteSync, CorruptStateError } from "../fs/atomic_write.js";
import { validateEvidenceFile } from "../evidence/tracker.js";
import { readEvidenceFile } from "../evidence/validator.js";
import { harvestWorkflowCompletion } from "../memory/episodic_harvester.js";

// ─── Run ID generation ─────────────────────────────────────────────────

function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = crypto.randomBytes(3).toString("hex");
  return `WF-${date}-${seq}`;
}

// ─── State persistence ─────────────────────────────────────────────────

function runsDir(): string {
  return path.join(os.homedir(), ".quiver", "workflow-runs");
}

function runFilePath(runId: string): string {
  return path.join(runsDir(), `${runId}.json`);
}

function ensureRunsDir(): void {
  fs.mkdirSync(runsDir(), { recursive: true });
}

function saveRun(run: WorkflowRun): void {
  ensureRunsDir();
  atomicWriteSync(runFilePath(run.run_id), JSON.stringify(run, null, 2));
}

function loadRun(runId: string): WorkflowRun | null {
  const p = runFilePath(runId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as WorkflowRun;
  } catch (error: any) {
    throw new CorruptStateError(p, `JSON parse failed: ${error?.message || String(error)}`);
  }
}

// ─── Event system ──────────────────────────────────────────────────────

export type EventListener = (event: WorkflowEvent) => void;

const listeners: EventListener[] = [];

export function onWorkflowEvent(listener: EventListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function emit(type: WorkflowEventType, run: WorkflowRun, data: Record<string, unknown> = {}): void {
  const event: WorkflowEvent = {
    type,
    run_id: run.run_id,
    workflow: run.workflow,
    timestamp: new Date().toISOString(),
    data,
  };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Don't let a listener error break the orchestrator
    }
  }
}

// ─── Phase executors ───────────────────────────────────────────────────

/**
 * Each phase executor receives the workflow definition, current run state,
 * and an optional agent callback for delegating work to the LLM agent.
 *
 * The `agentCallback` is the integration point with the existing Quiver agent
 * loop. When provided, the orchestrator delegates phase-specific work to the
 * agent rather than executing it inline.
 */
export type AgentCallback = (
  prompt: string,
  context: { phase: WorkflowPhase; workflow: WorkflowDefinition; run: WorkflowRun },
) => Promise<string>;

async function executeDiscover(
  def: WorkflowDefinition,
  run: WorkflowRun,
  agent?: AgentCallback,
): Promise<PhaseResult> {
  const started_at = new Date().toISOString();
  const artifacts: string[] = [];

  // Discover: identify and validate all input files
  const existingInputs: string[] = [];
  const missingInputs: string[] = [];

  for (const input of def.allowed_inputs) {
    const inputPath = path.join(def.packRoot, input);
    if (fs.existsSync(inputPath)) {
      existingInputs.push(input);
      run.inputs.push(inputPath);
    } else {
      missingInputs.push(input);
    }
  }

  let output = `Discovered ${existingInputs.length} input files.`;
  if (missingInputs.length > 0) {
    output += ` Missing: ${missingInputs.join(", ")}.`;
  }

  if (agent) {
    const agentOutput = await agent(
      `You are the Associate in the DISCOVER phase of the "${def.name}" workflow.\n` +
        `Business purpose: ${def.business_purpose}\n` +
        `Available inputs: ${existingInputs.join(", ")}\n` +
        `Missing inputs: ${missingInputs.join(", ") || "none"}\n` +
        `Identify the decision context, additional inputs needed, sensitivity concerns, ` +
        `and any data gaps. Confirm readiness only when the supplied evidence is sufficient; ` +
        `do not invent missing facts or imply that a deliverable is verified.`,
      { phase: "discover", workflow: def, run },
    );
    output += `\nAgent: ${agentOutput}`;
  }

  return {
    phase: "discover",
    status: "completed",
    started_at,
    completed_at: new Date().toISOString(),
    output,
    artifacts,
  };
}

async function executeMap(
  def: WorkflowDefinition,
  run: WorkflowRun,
  agent?: AgentCallback,
): Promise<PhaseResult> {
  const started_at = new Date().toISOString();

  // Map: build the source-to-deliverable mapping
  let output = `Mapped ${def.deliverable_sections.length} deliverable sections from ${run.inputs.length} inputs.`;

  if (agent) {
    const sections = def.deliverable_sections.join("\n  - ");
    const agentOutput = await agent(
      `You are the Associate in the MAP phase of the "${def.name}" workflow.\n` +
        `Map these deliverable sections to the available input sources:\n  - ${sections}\n` +
        `Inputs: ${run.inputs.map((i) => path.basename(i)).join(", ")}\n` +
        `For each section, identify the source file and location that provides the ` +
        `required data, flag unsupported sections, and distinguish facts from analysis.`,
      { phase: "map", workflow: def, run },
    );
    output += `\nAgent: ${agentOutput}`;
  }

  return {
    phase: "map",
    status: "completed",
    started_at,
    completed_at: new Date().toISOString(),
    output,
  };
}

async function executeBuild(
  def: WorkflowDefinition,
  run: WorkflowRun,
  agent?: AgentCallback,
): Promise<PhaseResult> {
  const started_at = new Date().toISOString();
  const errors: string[] = [];
  const artifacts: string[] = [];

  // Pre-build: run drift detection
  const driftResult = runDriftCheck(def);
  if (driftResult && driftResult.drifted) {
    return {
      phase: "build",
      status: "failed",
      started_at,
      completed_at: new Date().toISOString(),
      output: `Drift detected — halting build. ${driftResult.summary}`,
      errors: driftResult.mismatches.map(
        (m) => `${m.source}: expected ${m.expected}, got ${m.actual} (${m.reason})`,
      ),
    };
  }

  let output = "Build phase: ";
  if (driftResult) {
    output += "drift check passed. ";
  }

  if (agent) {
    const templateInfo = def.output_template
      ? `Output template: ${def.output_template}`
      : "No template specified — generate from scratch.";

    const agentOutput = await agent(
      `You are the Associate in the BUILD phase of the "${def.name}" workflow.\n` +
        `${templateInfo}\n` +
        `Deliverable sections: ${def.deliverable_sections.join(", ")}\n` +
        `Inputs available: ${run.inputs.map((i) => path.basename(i)).join(", ")}\n` +
        `Build a reviewable draft. Use the evidence tool to register every source, ` +
        `record every material quantitative claim, label estimates and unresolved ` +
        `items, and use OfficeCLI to produce the output files. Do not call the ` +
        `document final until validation and the independent checker pass.`,
      { phase: "build", workflow: def, run },
    );
    output += agentOutput;
  } else {
    const message = "No agent callback — build phase cannot produce a verified deliverable.";
    output += message;
    errors.push(message);
  }

  // Check for output files
  if (def.outputs?.directory) {
    const outDir = path.join(def.packRoot, def.outputs.directory);
    if (fs.existsSync(outDir)) {
      const files = fs.readdirSync(outDir);
      artifacts.push(...files.map((f) => path.join(outDir, f)));
      output += ` Generated ${files.length} output file(s).`;
    }
  }

  if (artifacts.length === 0) {
    errors.push("Build phase produced no output artifacts.");
  }

  return {
    phase: "build",
    status: errors.length > 0 ? "failed" : "completed",
    started_at,
    completed_at: new Date().toISOString(),
    output,
    errors: errors.length > 0 ? errors : undefined,
    artifacts,
  };
}

interface AcceptanceCheck {
  id: string;
  name: string;
  description: string;
}

function officecliJson(args: string[]): any {
  const bin = findBinary("officecli");
  if (!bin) throw new Error("officecli binary not found");
  const out = execFileSync(bin, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  try {
    return JSON.parse(out).data;
  } catch {
    return JSON.parse(out);
  }
}

function resolveWorkbookPath(fileHint: string, searchRoots: string[]): string | null {
  const base = path.basename(fileHint);
  const candidates = [
    fileHint,
    ...searchRoots.map((root) => path.join(root, base)),
    ...searchRoots.map((root) => path.join(root, fileHint)),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function readCellNumeric(
  workbook: string,
  sheet: string,
  cell: string,
): { ok: boolean; text: string; num: number } {
  const data = officecliJson(["get", workbook, `/${sheet}/${cell}`]);
  const text = String(data?.results?.[0]?.text ?? "");
  const num = Number(String(text).replace(/[^0-9.\-]/g, ""));
  return { ok: Number.isFinite(num), text, num };
}

function verifyExcelLineageAgainstWorkbooks(
  models: EvidenceModel[],
  searchRoots: string[],
): { pass: boolean; detail: string } {
  const claims = models.flatMap((m) =>
    m.claims.filter(
      (c) => c.verification?.type === "excel_cell" || c.verification?.type === "excel_derived",
    ),
  ) as ClaimRecord[];
  if (claims.length === 0) {
    return {
      pass: false,
      detail: "No Excel verification record was found in evidence.",
    };
  }
  const failures: string[] = [];
  let checked = 0;
  for (const claim of claims) {
    const v = claim.verification!;
    if (v.type === "excel_cell") {
      const cell = v as ExcelCellVerification;
      const wb = resolveWorkbookPath(cell.file, searchRoots);
      if (!wb) {
        failures.push(`${claim.claim_id}: workbook not found (${cell.file})`);
        continue;
      }
      try {
        const { ok, text, num } = readCellNumeric(wb, cell.sheet, cell.cell);
        checked++;
        if (!ok || Math.abs(num - cell.expected_raw) > 1e-6) {
          failures.push(
            `${claim.claim_id}: ${cell.sheet}!${cell.cell} expected ${cell.expected_raw}, got ${text || "(empty)"}`,
          );
        }
      } catch (e: any) {
        failures.push(`${claim.claim_id}: cell re-read failed (${e?.message || String(e)})`);
      }
    } else if (v.type === "excel_derived") {
      const der = v as ExcelDerivedVerification;
      const wb = resolveWorkbookPath(der.file, searchRoots);
      if (!wb) {
        failures.push(`${claim.claim_id}: workbook not found (${der.file})`);
        continue;
      }
      try {
        const num = readCellNumeric(wb, der.numerator.sheet, der.numerator.cell);
        const den = readCellNumeric(wb, der.denominator.sheet, der.denominator.cell);
        checked++;
        if (
          !num.ok ||
          Math.abs(num.num - der.numerator.expected_raw) > 1e-6 ||
          !den.ok ||
          Math.abs(den.num - der.denominator.expected_raw) > 1e-6
        ) {
          failures.push(
            `${claim.claim_id}: derived cells drifted (num=${num.text}, den=${den.text})`,
          );
        }
      } catch (e: any) {
        failures.push(`${claim.claim_id}: derived re-read failed (${e?.message || String(e)})`);
      }
    }
  }
  if (failures.length > 0) {
    return {
      pass: false,
      detail: `Excel lineage re-read failed: ${failures.slice(0, 3).join("; ")}`,
    };
  }
  if (checked === 0) {
    return {
      pass: false,
      detail: "Excel lineage records present but no cells could be re-read.",
    };
  }
  return {
    pass: true,
    detail: `Re-read and verified ${checked} Excel cell/derived record(s).`,
  };
}

function readAcceptanceChecks(checklistPath: string): AcceptanceCheck[] {
  const raw = fs.readFileSync(checklistPath, "utf8");
  return raw
    .split(/\n(?=\s*-\s*id:)/)
    .map((block) => {
      const id = block.match(/^\s*-\s*id:\s*(.+)$/m)?.[1]?.trim();
      const name = block.match(/^\s*name:\s*(.+)$/m)?.[1]?.trim() || "";
      const description = block.match(/^\s*description:\s*(.+)$/m)?.[1]?.trim() || "";
      return id ? { id, name, description } : null;
    })
    .filter((check): check is AcceptanceCheck => !!check);
}

function outputFilesForRun(def: WorkflowDefinition, run: WorkflowRun): string[] {
  const outputDir = def.outputs?.directory
    ? path.join(def.packRoot, def.outputs.directory)
    : def.packRoot;
  const files = fs.existsSync(outputDir)
    ? fs
        .readdirSync(outputDir)
        .map((file) => path.join(outputDir, file))
        .filter((file) => fs.statSync(file).isFile())
    : [];
  return [
    ...new Set(
      [...run.deliverables, ...files].filter(
        (file) => fs.existsSync(file) && fs.statSync(file).isFile(),
      ),
    ),
  ];
}

async function evaluateAcceptanceCheck(
  check: AcceptanceCheck,
  run: WorkflowRun,
  outputFiles: string[],
  def: WorkflowDefinition,
): Promise<{ pass: boolean; detail: string }> {
  const officeFiles = outputFiles.filter((file) => /\.(docx|xlsx|pptx)$/i.test(file));
  const evidence = await Promise.all(
    officeFiles.map(async (file) => ({
      validation: await validateEvidenceFile(file),
      loaded: await readEvidenceFile(file),
    })),
  );
  const validEvidence = evidence.filter((result) => result.validation.valid && result.loaded.model);
  const models = validEvidence
    .map((result) => result.loaded.model)
    .filter((model): model is NonNullable<typeof model> => !!model);
  const name = `${check.id} ${check.name} ${check.description}`.toLowerCase();

  if (
    check.id === "OUTPUT-FILES-EXIST" ||
    name.includes("deliverable_exists") ||
    name.includes("output")
  ) {
    return outputFiles.length > 0
      ? { pass: true, detail: `${outputFiles.length} output file(s) exist.` }
      : { pass: false, detail: "No non-empty output files were found." };
  }
  // Excel / cell lineage must run before the generic "lineage" companion check —
  // otherwise names like excel_lineage_verified match "lineage" and false-pass
  // on Evidence.json alone without any excel_cell / excel_derived records.
  if (name.includes("excel") || name.includes("cell")) {
    if (models.length === 0) {
      return {
        pass: false,
        detail: "No valid evidence models available to evaluate Excel lineage.",
      };
    }
    const searchRoots = [
      path.join(def.packRoot, def.outputs?.directory || "output"),
      path.join(def.packRoot, "inputs"),
      path.join(def.packRoot, "fixtures"),
      def.packRoot,
      path.join(def.packRoot, "..", "..", "examples", "investment-committee-memo", "fixtures"),
    ];
    const result = verifyExcelLineageAgainstWorkbooks(models, searchRoots);
    return result;
  }
  if (name.includes("evidence") || name.includes("lineage")) {
    return validEvidence.length === officeFiles.length && officeFiles.length > 0
      ? { pass: true, detail: "Every Office output has valid companion evidence." }
      : {
          pass: false,
          detail: `${validEvidence.length}/${officeFiles.length} Office outputs have valid companion evidence.`,
        };
  }
  if (name.includes("unresolved")) {
    if (models.length === 0) {
      return {
        pass: false,
        detail: "No valid evidence models available to evaluate unresolved claims.",
      };
    }
    const unresolved = models.flatMap((model) =>
      model.claims.filter(
        (claim) => claim.relationship === "unresolved" || claim.review_status === "unresolved",
      ),
    );
    if (unresolved.length === 0) {
      return {
        pass: true,
        detail: "0 unresolved item(s) are surfaced for review.",
      };
    }
    const noteOk = unresolved.every(
      (claim) => typeof claim.review_note === "string" && claim.review_note.trim(),
    );
    if (!noteOk) {
      return { pass: false, detail: "Unresolved claims lack a review note." };
    }
    // Stated criterion: listed in review checklist — require claim_ids appear
    // in a review checklist artifact among outputs (md/html/txt).
    const checklistFiles = outputFiles.filter((f) =>
      /review.?checklist|checklist/i.test(path.basename(f)),
    );
    if (checklistFiles.length === 0) {
      return {
        pass: false,
        detail: "No review checklist artifact found among outputs to surface unresolved items.",
      };
    }
    const checklistText = checklistFiles
      .map((f) => {
        try {
          return fs.readFileSync(f, "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    const missing = unresolved.filter((c) => !checklistText.includes(c.claim_id));
    return missing.length === 0
      ? {
          pass: true,
          detail: `${unresolved.length} unresolved item(s) listed in review checklist.`,
        }
      : {
          pass: false,
          detail: `Unresolved claims missing from checklist: ${missing.map((c) => c.claim_id).join(", ")}`,
        };
  }

  return {
    pass: false,
    detail: `Unsupported acceptance check "${check.id}" was not evaluated.`,
  };
}

async function executeVerify(
  def: WorkflowDefinition,
  run: WorkflowRun,
  agent?: AgentCallback,
): Promise<PhaseResult> {
  const started_at = new Date().toISOString();
  const errors: string[] = [];

  const checkResults: Array<{ id: string; pass: boolean; detail: string }> = [];
  if (!def.acceptance_checks) {
    errors.push("Verify phase requires an acceptance checklist.");
  } else {
    const checklistPath = path.join(def.packRoot, def.acceptance_checks);
    if (!fs.existsSync(checklistPath)) {
      errors.push(`Acceptance checklist is missing: ${checklistPath}`);
    } else {
      const checks = readAcceptanceChecks(checklistPath);
      if (checks.length === 0) {
        errors.push("Acceptance checklist contains no evaluable checks.");
      } else {
        const outputFiles = outputFilesForRun(def, run);
        for (const check of checks) {
          const result = await evaluateAcceptanceCheck(check, run, outputFiles, def);
          checkResults.push({ id: check.id, ...result });
          if (!result.pass) {
            errors.push(`Check ${check.id} failed: ${result.detail}`);
          }
        }
      }
    }
  }

  let output = `Verify phase: evaluated ${checkResults.length} acceptance checks (${checkResults.filter((c) => c.pass).length}/${checkResults.length} passed).`;

  if (agent) {
    const agentOutput = await agent(
      `You are reporting the VP check for the "${def.name}" workflow.\n` +
        `Use the actual acceptance results below; do not override a failed or ` +
        `unsupported check with an opinion.\n` +
        `Checks to verify:\n` +
        checkResults
          .map((c) => `  - ${c.id}: ${c.pass ? "PASS" : "FAIL"} (${c.detail})`)
          .join("\n") +
        `\nFor each check, explain the supplied evidence or the missing evidence. ` +
        `A zero-check or infrastructure failure is not approval.`,
      { phase: "verify", workflow: def, run },
    );
    output += `\nAgent: ${agentOutput}`;
  }

  return {
    phase: "verify",
    status: errors.length > 0 ? "failed" : "completed",
    started_at,
    completed_at: new Date().toISOString(),
    output,
    errors: errors.length > 0 ? errors : undefined,
    checks: checkResults,
  };
}

async function executeTrain(
  def: WorkflowDefinition,
  run: WorkflowRun,
  agent?: AgentCallback,
): Promise<PhaseResult> {
  const started_at = new Date().toISOString();

  let output = "Train phase: documenting workflow execution for knowledge transfer.";

  if (agent) {
    const agentOutput = await agent(
      `You are the Associate in the TRAIN phase of the "${def.name}" workflow.\n` +
        `Document the key decisions, data interpretations, and manual steps ` +
        `performed during this workflow run so a new analyst can replicate the process. ` +
        `Separate reusable process lessons from engagement-specific facts; candidate ` +
        `lessons remain pending review.`,
      { phase: "train", workflow: def, run },
    );
    output += `\nAgent: ${agentOutput}`;
  }

  return {
    phase: "train",
    status: "completed",
    started_at,
    completed_at: new Date().toISOString(),
    output,
  };
}

async function executeHandover(
  def: WorkflowDefinition,
  run: WorkflowRun,
  agent?: AgentCallback,
): Promise<PhaseResult> {
  const started_at = new Date().toISOString();
  const artifacts: string[] = [];

  // Generate the handover runbook
  const runbookPath = path.join(
    def.packRoot,
    def.outputs?.directory || ".",
    `${def.name}_Runbook.md`,
  );

  const runbook = generateRunbook(def, run);

  try {
    const runbookDir = path.dirname(runbookPath);
    fs.mkdirSync(runbookDir, { recursive: true });
    fs.writeFileSync(runbookPath, runbook);
    artifacts.push(runbookPath);
  } catch {
    // Non-fatal — runbook generation failure shouldn't block completion
  }

  let output = `Handover phase: runbook generated at ${path.basename(runbookPath)}.`;

  if (agent) {
    const agentOutput = await agent(
      `You are the Associate in the HANDOVER phase of the "${def.name}" workflow.\n` +
        `Review the generated runbook and add any firm-specific maintenance notes ` +
        `or recurring schedule recommendations. Keep authentication, sensitivity, ` +
        `and reviewer ownership explicit; do not imply that a template is production-ready.`,
      { phase: "handover", workflow: def, run },
    );
    output += `\nAgent: ${agentOutput}`;
  }

  return {
    phase: "handover",
    status: "completed",
    started_at,
    completed_at: new Date().toISOString(),
    output,
    artifacts,
  };
}

// ─── Drift integration ────────────────────────────────────────────────

function runDriftCheck(def: WorkflowDefinition): DriftResult | null {
  const expected = loadExpectedStructure(def.packRoot);
  if (!expected) return null;

  const sourcesDir = path.join(def.packRoot, "sample-inputs");
  return checkDrift(expected, sourcesDir);
}

// ─── Runbook generation ───────────────────────────────────────────────

function generateRunbook(def: WorkflowDefinition, run: WorkflowRun): string {
  const sections: string[] = [];

  sections.push(`# ${def.name} — Operating Runbook`);
  sections.push(`\n_Generated: ${new Date().toISOString()}_`);
  sections.push(`_Run ID: ${run.run_id}_\n`);

  sections.push(`## Purpose\n\n${def.business_purpose}\n`);

  sections.push(`## Inputs\n`);
  for (const input of run.inputs) {
    sections.push(`- \`${path.basename(input)}\``);
  }
  sections.push("");

  sections.push(`## Deliverable Sections\n`);
  for (const section of def.deliverable_sections) {
    sections.push(`- ${section}`);
  }
  sections.push("");

  sections.push(`## Execution Summary\n`);
  sections.push(`| Phase | Status | Duration |`);
  sections.push(`|-------|--------|----------|`);
  for (const phase of run.phases) {
    const start = new Date(phase.started_at).getTime();
    const end = new Date(phase.completed_at).getTime();
    const durationMs = end - start;
    const durationStr =
      durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
    sections.push(`| ${phase.phase} | ${phase.status} | ${durationStr} |`);
  }
  sections.push("");

  if (run.deliverables.length > 0) {
    sections.push(`## Deliverables\n`);
    for (const d of run.deliverables) {
      sections.push(`- \`${path.basename(d)}\``);
    }
    sections.push("");
  }

  if (def.review_role) {
    sections.push(`## Review\n\n${def.review_role}\n`);
  }

  sections.push(`## Maintenance\n`);
  sections.push(`- Re-run this workflow when new input data is available.`);
  sections.push(
    `- If source file structures change, update \`expected-structure.json\` to pass drift checks.`,
  );
  sections.push(
    `- Review acceptance checklist (${def.acceptance_checks || "N/A"}) before sign-off.\n`,
  );

  return sections.join("\n");
}

// ─── Phase dispatch ────────────────────────────────────────────────────

const PHASE_EXECUTORS: Record<
  WorkflowPhase,
  (def: WorkflowDefinition, run: WorkflowRun, agent?: AgentCallback) => Promise<PhaseResult>
> = {
  discover: executeDiscover,
  map: executeMap,
  build: executeBuild,
  verify: executeVerify,
  train: executeTrain,
  handover: executeHandover,
};

// ─── Orchestrator ──────────────────────────────────────────────────────

export interface OrchestratorOptions {
  /** Callback for delegating phase work to the LLM agent */
  agent?: AgentCallback;
  /** Trigger source */
  trigger?: "manual" | "schedule" | "watch" | "api";
  /** Phases to skip */
  skipPhases?: WorkflowPhase[];
  /** Resume from a specific run ID */
  resumeRunId?: string;
  /** Actual file that triggered a watched run, when applicable */
  triggerInput?: string;
}

/**
 * Execute a workflow definition through all phases.
 *
 * This is the core "run" function — it steps through discover → map →
 * build → verify → train → handover, persisting state at each checkpoint.
 */
export async function executeWorkflow(
  def: WorkflowDefinition,
  options: OrchestratorOptions = {},
): Promise<WorkflowRun> {
  const { agent, trigger = "manual", skipPhases = [], resumeRunId, triggerInput } = options;

  // Create or resume a run
  let run: WorkflowRun;
  if (resumeRunId) {
    const existing = loadRun(resumeRunId);
    if (!existing) {
      throw new Error(`Run ${resumeRunId} not found`);
    }
    run = existing;
    run.status = "running";
  } else {
    run = {
      run_id: generateRunId(),
      workflow: def.name,
      family: def.family,
      status: "running",
      current_phase: null,
      phases: [],
      started_at: new Date().toISOString(),
      completed_at: null,
      inputs: [],
      deliverables: [],
      trigger,
    };
  }

  if (triggerInput) {
    const resolvedInput = path.resolve(triggerInput);
    if (!run.inputs.includes(resolvedInput)) {
      run.inputs.push(resolvedInput);
    }
  }

  emit("workflow:started", run, { trigger });
  saveRun(run);

  // Determine which phases to run
  const completedPhases = new Set(run.phases.map((p) => p.phase));
  const phasesToRun = PHASE_ORDER.filter((p) => !completedPhases.has(p) && !skipPhases.includes(p));

  for (const phase of phasesToRun) {
    run.current_phase = phase;
    emit("workflow:phase_started", run, { phase });
    saveRun(run);

    try {
      const executor = PHASE_EXECUTORS[phase];
      const result = await executor(def, run, agent);
      run.phases.push(result);

      // Collect deliverables from phase artifacts
      if (result.artifacts) {
        run.deliverables.push(...result.artifacts);
      }

      emit("workflow:phase_completed", run, { phase, status: result.status });

      if (result.status === "failed") {
        run.status = "failed";
        run.error = result.errors?.join("; ") || `Phase ${phase} failed`;
        run.completed_at = new Date().toISOString();
        emit("workflow:failed", run, { phase, error: run.error });
        saveRun(run);
        return run;
      }
    } catch (err: any) {
      const error = err?.message || String(err);
      run.status = "failed";
      run.error = `Phase ${phase} threw: ${error}`;
      run.completed_at = new Date().toISOString();
      run.phases.push({
        phase,
        status: "failed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        errors: [error],
      });
      emit("workflow:failed", run, { phase, error });
      saveRun(run);
      return run;
    }

    saveRun(run);
  }

  // All phases completed
  run.status = "completed";
  run.current_phase = null;
  run.completed_at = new Date().toISOString();
  saveRun(run);

  // Harvest only explicitly labelled lessons into the pending memory queue.
  // A harvest failure must be visible but must not rewrite a completed Office
  // deliverable as failed after its acceptance checks passed.
  try {
    const harvested = await harvestWorkflowCompletion(def, run);
    emit("workflow:completed", run, {
      harvested_memory_candidates: harvested.created,
    });
  } catch (error: any) {
    const harvestError = error?.message || String(error);
    console.warn(`Workflow memory harvest failed for ${run.run_id}: ${harvestError}`);
    emit("workflow:completed", run, {
      harvested_memory_candidates: 0,
      memory_harvest_error: harvestError,
    });
  }

  return run;
}

// ─── Run management ───────────────────────────────────────────────────

/**
 * List all workflow runs, optionally filtered by workflow name.
 */
export function listRuns(workflowName?: string): WorkflowRun[] {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const runs: WorkflowRun[] = [];

  for (const file of files) {
    try {
      const run = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as WorkflowRun;
      if (!workflowName || run.workflow === workflowName) {
        runs.push(run);
      }
    } catch (error: any) {
      console.warn(
        new CorruptStateError(path.join(dir, file), error?.message || String(error)).message,
      );
    }
  }

  return runs.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
}

/**
 * Get a specific workflow run by ID.
 */
export function getRun(runId: string): WorkflowRun | null {
  return loadRun(runId);
}

/**
 * Cancel a running workflow.
 */
export function cancelRun(runId: string): boolean {
  const run = loadRun(runId);
  if (!run || run.status !== "running") return false;

  run.status = "cancelled";
  run.completed_at = new Date().toISOString();
  run.error = "Cancelled by user";
  saveRun(run);
  return true;
}
