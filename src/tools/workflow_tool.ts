/**
 * Workflow Tool — agent-facing tool for workflow orchestration.
 *
 * The agent can discover, run, inspect, schedule, and watch workflows
 * programmatically during a conversation. This is the ambient AI
 * integration point: the agent uses this tool to trigger full workflow
 * pipelines from natural language requests.
 *
 * SPEC §12 / §19 Build Order #7.
 */

import { z } from "zod";
import * as path from "path";
import { Tool } from "../registry.js";
import { discoverWorkflows, findWorkflow } from "../workflow/loader.js";
import {
  executeWorkflow,
  listRuns,
  getRun,
  cancelRun,
  type AgentCallback,
} from "../workflow/orchestrator.js";
import { WorkflowScheduler, isValidCron, describeCron } from "../workflow/scheduler.js";
import { WorkflowWatcher } from "../workflow/watcher.js";
import { reviewManager } from "../workflow/review.js";
import { generateHandover, writeHandover } from "../workflow/handover.js";
import type { WorkflowDefinition, WorkflowPhase } from "../workflow/types.js";

// ─── Default packs directory ──────────────────────────────────────────

function defaultPacksDir(): string {
  return path.join(process.cwd(), "workflow-packs");
}

// ─── Tool definition ──────────────────────────────────────────────────

export const tool: Tool = {
  name: "workflow",
  description:
    "Manage and execute workflow packs for ambient AI document production. " +
    "Actions: 'list' (discover available packs), 'run' (execute a workflow), " +
    "'status' (check run status), 'history' (list past runs), 'cancel' (stop a run), " +
    "'schedule' (set up recurring execution), 'watch' (monitor directories for triggers), " +
    "'review' (manage document review chain), 'handover' (generate training runbook). " +
    "Use this to orchestrate the full discover→map→build→verify→train→handover lifecycle.",
  parameters: z.object({
    action: z
      .enum([
        "list",
        "run",
        "status",
        "history",
        "cancel",
        "schedule",
        "watch",
        "review",
        "handover",
      ])
      .describe("The workflow action to perform"),
    workflow: z
      .string()
      .optional()
      .describe("Workflow name (e.g., 'investment-committee-memo')"),
    run_id: z
      .string()
      .optional()
      .describe("Workflow run ID (for status/cancel/review/handover)"),
    cron: z
      .string()
      .optional()
      .describe("Cron expression for schedule action (e.g., '0 8 * * 1' for Monday 8am)"),
    watch_dir: z
      .string()
      .optional()
      .describe("Directory to watch for file triggers"),
    watch_pattern: z
      .string()
      .optional()
      .describe("File glob pattern for watch triggers (e.g., '*.xlsx')"),
    reviewer: z
      .string()
      .optional()
      .describe("Reviewer name for review decisions"),
    review_role: z
      .string()
      .optional()
      .describe("Review role (analyst, vp, partner, pm, cio, advisor)"),
    review_decision: z
      .enum(["approved", "rejected", "commented"])
      .optional()
      .describe("Review decision"),
    comment: z
      .string()
      .optional()
      .describe("Review comment"),
    skip_phases: z
      .array(z.string())
      .optional()
      .describe("Phases to skip during execution"),
  }),
  execute: async (args: any) => {
    const packsDir = defaultPacksDir();

    switch (args.action) {
      // ── List available workflow packs ──
      case "list": {
        const workflows = discoverWorkflows(packsDir);
        if (workflows.length === 0) {
          return { status: "ok", message: "No workflow packs found.", workflows: [] };
        }
        return {
          status: "ok",
          count: workflows.length,
          workflows: workflows.map((w) => ({
            name: w.name,
            family: w.family,
            version: w.version,
            maturity: w.maturity,
            purpose: w.business_purpose.slice(0, 120),
            sections: w.deliverable_sections.length,
            inputs: w.allowed_inputs.length,
          })),
        };
      }

      // ── Run a workflow ──
      case "run": {
        if (!args.workflow) {
          return { status: "error", message: "Specify a workflow name." };
        }
        const def = findWorkflow(args.workflow, packsDir);
        if (!def) {
          const available = discoverWorkflows(packsDir).map((w) => w.name);
          return {
            status: "error",
            message: `Workflow "${args.workflow}" not found.`,
            available,
          };
        }
        const skipPhases = (args.skip_phases || []) as WorkflowPhase[];
        const run = await executeWorkflow(def, {
          trigger: "api",
          skipPhases,
        });
        return {
          status: "ok",
          run_id: run.run_id,
          workflow: run.workflow,
          result: run.status,
          phases: run.phases.map((p) => ({
            phase: p.phase,
            status: p.status,
          })),
          deliverables: run.deliverables.map((d) => path.basename(d)),
          error: run.error || undefined,
        };
      }

      // ── Check run status ──
      case "status": {
        if (!args.run_id) {
          return { status: "error", message: "Specify a run_id." };
        }
        const run = getRun(args.run_id);
        if (!run) {
          return { status: "error", message: `Run "${args.run_id}" not found.` };
        }
        return {
          status: "ok",
          run_id: run.run_id,
          workflow: run.workflow,
          result: run.status,
          current_phase: run.current_phase,
          phases: run.phases.map((p) => ({
            phase: p.phase,
            status: p.status,
          })),
          started_at: run.started_at,
          completed_at: run.completed_at,
          error: run.error || undefined,
        };
      }

      // ── List past runs ──
      case "history": {
        const runs = listRuns(args.workflow);
        return {
          status: "ok",
          count: runs.length,
          runs: runs.slice(0, 20).map((r) => ({
            run_id: r.run_id,
            workflow: r.workflow,
            status: r.status,
            trigger: r.trigger,
            started_at: r.started_at,
            completed_at: r.completed_at,
          })),
        };
      }

      // ── Cancel a run ──
      case "cancel": {
        if (!args.run_id) {
          return { status: "error", message: "Specify a run_id." };
        }
        const cancelled = cancelRun(args.run_id);
        return {
          status: cancelled ? "ok" : "error",
          message: cancelled
            ? `Run ${args.run_id} cancelled.`
            : `Could not cancel run ${args.run_id} (not found or not running).`,
        };
      }

      // ── Schedule a recurring workflow ──
      case "schedule": {
        if (!args.workflow || !args.cron) {
          return {
            status: "error",
            message: "Specify workflow name and cron expression.",
          };
        }
        if (!isValidCron(args.cron)) {
          return {
            status: "error",
            message: `Invalid cron expression: "${args.cron}". Use 5-field format: minute hour day-of-month month day-of-week.`,
          };
        }
        const scheduler = new WorkflowScheduler();
        const entry = scheduler.addSchedule(
          args.workflow,
          args.cron,
          packsDir,
          args.comment,
        );
        return {
          status: "ok",
          schedule_id: entry.id,
          workflow: entry.workflow,
          cron: entry.cron,
          description: describeCron(entry.cron),
          message: `Scheduled "${args.workflow}" — ${describeCron(args.cron)}.`,
        };
      }

      // ── Set up a file watch ──
      case "watch": {
        if (!args.workflow || !args.watch_dir) {
          return {
            status: "error",
            message: "Specify workflow name and watch_dir.",
          };
        }
        const watcher = new WorkflowWatcher();
        const rule = watcher.addRule(
          [args.watch_dir],
          [args.watch_pattern || "*"],
          args.workflow,
          packsDir,
        );
        return {
          status: "ok",
          watch_id: rule.id,
          workflow: rule.workflow,
          directories: rule.directories,
          patterns: rule.patterns,
          message: `Watching ${args.watch_dir} for ${args.watch_pattern || "all files"} → triggers "${args.workflow}".`,
        };
      }

      // ── Manage document review ──
      case "review": {
        if (args.run_id && args.review_decision && args.review_role && args.reviewer) {
          // Submit a decision
          try {
            const review = reviewManager.submitDecision(
              args.run_id,
              args.review_role as any,
              args.reviewer,
              args.review_decision,
              args.comment,
            );
            if (!review) {
              return { status: "error", message: `No review found for run ${args.run_id}.` };
            }
            return {
              status: "ok",
              review_status: review.status,
              stage: review.stage,
              decisions: review.decisions.length,
              formatted: reviewManager.formatReviewStatus(review),
            };
          } catch (err: any) {
            return { status: "error", message: err?.message || String(err) };
          }
        }

        if (args.run_id) {
          // Get review status
          let review = reviewManager.getReview(args.run_id);
          if (!review) {
            // Create a new review
            const run = getRun(args.run_id);
            if (!run) {
              return { status: "error", message: `Run "${args.run_id}" not found.` };
            }
            review = reviewManager.createReview(
              run.deliverables[0] || "unknown",
              args.run_id,
              run.family,
            );
          }
          return {
            status: "ok",
            formatted: reviewManager.formatReviewStatus(review),
          };
        }

        // List all reviews
        const reviews = reviewManager.listReviews();
        return {
          status: "ok",
          count: reviews.length,
          reviews: reviews.slice(0, 20).map((r) => ({
            run_id: r.run_id,
            document: r.document,
            status: r.status,
            stage: r.stage,
            decisions: r.decisions.length,
          })),
        };
      }

      // ── Generate handover ──
      case "handover": {
        if (!args.run_id) {
          return { status: "error", message: "Specify a run_id." };
        }
        const run = getRun(args.run_id);
        if (!run) {
          return { status: "error", message: `Run "${args.run_id}" not found.` };
        }
        const def = findWorkflow(run.workflow, packsDir);
        if (!def) {
          return {
            status: "error",
            message: `Workflow "${run.workflow}" not found in packs.`,
          };
        }
        const handover = generateHandover(def, run);
        const outputDir = def.outputs?.directory
          ? path.join(def.packRoot, def.outputs.directory)
          : def.packRoot;
        const runbookPath = writeHandover(handover, outputDir);
        return {
          status: "ok",
          runbook_path: runbookPath,
          acceptance_results: handover.acceptance_results,
          message: `Handover runbook generated: ${path.basename(runbookPath)}`,
        };
      }

      default:
        return { status: "error", message: `Unknown action: ${args.action}` };
    }
  },
};
