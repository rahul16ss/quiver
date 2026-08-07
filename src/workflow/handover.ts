/**
 * Workflow Handover — training & runbook generation.
 *
 * Auto-generates an operating runbook (Markdown) from a completed
 * workflow run, recording: inputs used, steps taken, acceptance checks
 * passed, reviewer actions, and maintenance instructions.
 *
 * This is the "train your replacement" module — it produces a document
 * that a new analyst can follow to replicate the workflow without the
 * AI, or that a senior can use to audit what the AI did.
 *
 * SPEC §12.6 / §19.
 */

import * as fs from "fs";
import * as path from "path";
import type { WorkflowDefinition, WorkflowRun, HandoverPackage, DocumentReview } from "./types.js";
import { reviewManager } from "./review.js";

// ─── Handover Generator ───────────────────────────────────────────────

/**
 * Generate a complete handover package from a workflow run.
 */
export function generateHandover(def: WorkflowDefinition, run: WorkflowRun): HandoverPackage {
  const review = reviewManager.getReview(run.run_id);
  const runbook = buildRunbook(def, run, review);

  // Parse acceptance results from the verify phase
  const verifyPhase = run.phases.find((p) => p.phase === "verify");
  const acceptanceResults = verifyPhase?.checks || [];

  return {
    workflow: def.name,
    run_id: run.run_id,
    runbook,
    acceptance_results: acceptanceResults,
    inputs_used: run.inputs,
    deliverables: run.deliverables,
    maintenance_notes: buildMaintenanceNotes(def),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Write a handover package to disk.
 */
export function writeHandover(handover: HandoverPackage, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });

  // Write the runbook as Markdown
  const runbookPath = path.join(outputDir, `${handover.workflow}_Handover.md`);
  fs.writeFileSync(runbookPath, handover.runbook);

  // Write the structured package as JSON
  const packagePath = path.join(outputDir, `${handover.workflow}_Handover.json`);
  fs.writeFileSync(packagePath, JSON.stringify(handover, null, 2));

  return runbookPath;
}

// ─── Runbook builder ──────────────────────────────────────────────────

function buildRunbook(
  def: WorkflowDefinition,
  run: WorkflowRun,
  review: DocumentReview | null,
): string {
  const lines: string[] = [];

  // ── Header ──
  lines.push(`# ${titleCase(def.name)} — Operating Runbook`);
  lines.push("");
  lines.push(`> Auto-generated from workflow run \`${run.run_id}\``);
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push("");

  // ── Purpose ──
  lines.push("## 1. Purpose");
  lines.push("");
  lines.push(def.business_purpose);
  lines.push("");

  // ── Prerequisites ──
  lines.push("## 2. Prerequisites");
  lines.push("");
  lines.push("Before running this workflow, ensure you have:");
  lines.push("");
  lines.push("- Quiver installed and configured (`quiver --version`)");
  if (def.retrieval?.network_access !== "none") {
    lines.push("- Network access for data retrieval");
  }
  if (def.output_template) {
    lines.push(`- Output template: \`${def.output_template}\``);
  }
  lines.push("");

  // ── Input Files ──
  lines.push("## 3. Required Inputs");
  lines.push("");
  lines.push("| # | File | Status |");
  lines.push("|---|------|--------|");
  for (let i = 0; i < def.allowed_inputs.length; i++) {
    const input = def.allowed_inputs[i];
    const found = run.inputs.some((p) => p.endsWith(path.basename(input)));
    lines.push(`| ${i + 1} | \`${input}\` | ${found ? "✓ Used" : "○ Optional"} |`);
  }
  lines.push("");

  // ── Step-by-Step ──
  lines.push("## 4. Execution Steps");
  lines.push("");
  for (const phase of run.phases) {
    const emoji = phase.status === "completed" ? "✅" : phase.status === "failed" ? "❌" : "⏭️";
    lines.push(`### ${emoji} Phase: ${titleCase(phase.phase)}`);
    lines.push("");
    if (phase.output) {
      lines.push(phase.output);
      lines.push("");
    }
    if (phase.errors && phase.errors.length > 0) {
      lines.push("**Errors:**");
      for (const err of phase.errors) {
        lines.push(`- ⚠️ ${err}`);
      }
      lines.push("");
    }
    if (phase.artifacts && phase.artifacts.length > 0) {
      lines.push("**Artifacts produced:**");
      for (const a of phase.artifacts) {
        lines.push(`- \`${path.basename(a)}\``);
      }
      lines.push("");
    }
    const start = new Date(phase.started_at).getTime();
    const end = new Date(phase.completed_at).getTime();
    const duration = end - start;
    const durationStr = duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`;
    lines.push(`_Duration: ${durationStr}_`);
    lines.push("");
  }

  // ── Deliverables ──
  lines.push("## 5. Deliverables");
  lines.push("");
  if (run.deliverables.length > 0) {
    for (const d of run.deliverables) {
      lines.push(`- \`${path.basename(d)}\``);
    }
  } else {
    lines.push("_No deliverables recorded._");
  }
  lines.push("");

  // ── Review Status ──
  lines.push("## 6. Review Status");
  lines.push("");
  if (review) {
    lines.push(`Overall: **${review.status.toUpperCase()}**`);
    lines.push("");
    lines.push("| Role | Decision | Reviewer | Comment |");
    lines.push("|------|----------|----------|---------|");
    for (const dec of review.decisions) {
      lines.push(`| ${dec.role} | ${dec.decision} | ${dec.reviewer} | ${dec.comment || "—"} |`);
    }
    const pendingRoles = review.required_reviewers.filter(
      (r) => !review.decisions.some((d) => d.role === r),
    );
    for (const role of pendingRoles) {
      lines.push(`| ${role} | pending | — | — |`);
    }
  } else {
    lines.push("_No review record found. Use `/workflow review` to initiate._");
  }
  lines.push("");

  // ── Data Sensitivity ──
  lines.push("## 7. Data Sensitivity");
  lines.push("");
  lines.push(`Classification: **${def.data_sensitivity}**`);
  lines.push("");
  if (def.data_sensitivity === "mnpi") {
    lines.push(
      "> ⚠️ **MNPI**: This workflow handles material non-public information. " +
        "All data must remain within approved boundaries.",
    );
  } else if (def.data_sensitivity === "confidential") {
    lines.push(
      "> ⚠️ **Confidential**: Do not share output files outside the firm " +
        "without proper authorization.",
    );
  }
  lines.push("");

  // ── Maintenance ──
  lines.push("## 8. Maintenance Notes");
  lines.push("");
  lines.push(buildMaintenanceNotes(def));
  lines.push("");

  // ── CLI Quick Reference ──
  lines.push("## 9. CLI Quick Reference");
  lines.push("");
  lines.push("```bash");
  lines.push(`# List all workflow packs`);
  lines.push(`quiver workflow list`);
  lines.push("");
  lines.push(`# Run this workflow`);
  lines.push(`quiver workflow run ${def.name}`);
  lines.push("");
  lines.push(`# Schedule recurring execution`);
  lines.push(`quiver workflow schedule ${def.name} --cron "0 8 * * 1"`);
  lines.push("");
  lines.push(`# Watch for new input files`);
  lines.push(`quiver workflow watch ${def.name} --dir ./inbox --pattern "*.xlsx"`);
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────

function buildMaintenanceNotes(def: WorkflowDefinition): string {
  const notes: string[] = [];

  notes.push("- Re-run this workflow whenever updated input data is available.");
  notes.push(
    "- If source file structures change (new tabs, moved cells), " +
      "update `expected-structure.json` to pass drift checks.",
  );

  if (def.acceptance_checks) {
    notes.push(
      `- Acceptance checklist: \`${def.acceptance_checks}\` — review before final sign-off.`,
    );
  }

  if (def.schedule) {
    notes.push(
      `- Scheduled: ${def.schedule.cron}${def.schedule.label ? ` (${def.schedule.label})` : ""}.`,
    );
  }

  notes.push("- Quiver version and OfficeCLI must be kept up to date for template compatibility.");

  return notes.join("\n");
}

function titleCase(str: string): string {
  return str.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
