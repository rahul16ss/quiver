import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { getProjectSessionsDir } from "../paths.js";

/**
 * Ralph Loop — iterative self-referential development.
 *
 * Inspired by Geoffrey Huntley's Ralph Wiggum technique and the Cursor ralph-loop plugin.
 * Adapted for Quiver with full transparency.
 *
 * The agent feeds the same prompt back to itself after every turn, seeing its own
 * previous work in the files and git history. It iterates until:
 * - A completion promise is fulfilled, OR
 * - Max iterations is reached, OR
 * - The user cancels
 *
 * State is stored in .sessions/ralph-loop.json for transparency and debuggability.
 *
 * Key difference from Cursor's implementation:
 * - Quiver doesn't have hooks, so the loop is driven by the agent itself
 * - The agent calls ralph_loop to start, then calls it again after each turn to check
 *   if it should continue or stop
 * - Full transparency: the user sees every iteration, the state file is visible
 */

interface RalphState {
  active: boolean;
  iteration: number;
  maxIterations: number;
  completionPromise: string | null;
  prompt: string;
  startedAt: number;
  lastIterationAt: number;
}

function getStatePath(): string {
  return path.join(getProjectSessionsDir(), "ralph-loop.json");
}

async function loadState(): Promise<RalphState | null> {
  try {
    const content = await fs.readFile(getStatePath(), "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveState(state: RalphState): Promise<void> {
  const p = getStatePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state, null, 2), "utf8");
}

async function clearState(): Promise<void> {
  try {
    await fs.unlink(getStatePath());
  } catch {
    // Already gone
  }
}

export const tool: Tool = {
  name: "ralph_loop",
  description:
    "Manages an iterative self-referential development loop (Ralph Loop). " +
    "The same prompt is fed back after every turn — the agent sees its own previous work " +
    "in the files and git history, and iterates until completion. " +
    "Use for well-defined tasks with clear success criteria (tests passing, migration complete, feature built from spec). " +
    "NOT for tasks requiring human judgment or ambiguous goals. " +
    "TRANSPARENT: the user sees every iteration and the state file is visible at .sessions/ralph-loop.json. " +
    "Actions: 'start' to begin a loop, 'next' to check if another iteration should run, 'cancel' to stop, 'status' to check state.",
  parameters: z.object({
    action: z
      .enum(["start", "next", "cancel", "status"])
      .describe(
        "Action: 'start' to begin a new loop (requires prompt), 'next' to check if another iteration should run and get the prompt, 'cancel' to stop the loop, 'status' to check current state.",
      ),
    prompt: z
      .string()
      .optional()
      .describe(
        "The task prompt to repeat each iteration. Required for 'start' action.",
      ),
    maxIterations: z
      .number()
      .optional()
      .describe(
        "Maximum iterations before auto-stop. Default: 50. Set to 0 for unlimited (not recommended).",
      ),
    completionPromise: z
      .string()
      .optional()
      .describe(
        "A phrase that signals completion. When the agent outputs this exact phrase, the loop stops. Example: 'TASK COMPLETE'. Set to null or omit for no promise (relies on max_iterations only).",
      ),
  }),
  execute: async ({ action, prompt, maxIterations, completionPromise }) => {
    try {
      switch (action) {
        case "start": {
          if (!prompt) {
            return "Error: 'prompt' is required for 'start' action.";
          }

          // Check if a loop is already active
          const existing = await loadState();
          if (existing && existing.active) {
            return `Error: A Ralph loop is already active (iteration ${existing.iteration}/${existing.maxIterations || "∞"}). Use action='cancel' to stop it first, or action='status' to check state.`;
          }

          const max = maxIterations ?? 50;
          const promise = completionPromise || null;

          const state: RalphState = {
            active: true,
            iteration: 1,
            maxIterations: max,
            completionPromise: promise,
            prompt,
            startedAt: Date.now(),
            lastIterationAt: Date.now(),
          };

          await saveState(state);

          const lines: string[] = [];
          lines.push("╔══ Ralph Loop Started ═══════════════════════════╗");
          lines.push(`║  Iteration: 1/${max || "∞"}`);
          lines.push(
            `║  Completion promise: ${promise || "none (relies on max_iterations)"}`,
          );
          lines.push(`║  State file: ${getStatePath()}`);
          lines.push("║");
          lines.push("║  The same prompt will repeat each iteration.");
          lines.push("║  You will see your previous work in the files.");
          lines.push("║  Iterate until the task is complete.");
          lines.push("║");
          lines.push("║  To complete: output the completion promise");
          lines.push("║  ONLY when it is genuinely true.");
          lines.push("║");
          lines.push("║  To cancel: call ralph_loop with action='cancel'");
          lines.push("╚════════════════════════════════════════════════╝");
          lines.push("");
          lines.push("=== PROMPT (iteration 1) ===");
          lines.push(prompt);

          return lines.join("\n");
        }

        case "next": {
          const state = await loadState();
          if (!state || !state.active) {
            return "No active Ralph loop. Use action='start' to begin one.";
          }

          // Check if completion promise was in the last response
          // (The agent should check this itself, but we also check state)

          // Check max iterations
          if (
            state.maxIterations > 0 &&
            state.iteration >= state.maxIterations
          ) {
            await clearState();
            return `Ralph loop: max iterations (${state.maxIterations}) reached. Loop ended.\n\nState file removed. The task may or may not be complete — review the work.`;
          }

          // Increment iteration
          state.iteration++;
          state.lastIterationAt = Date.now();
          await saveState(state);

          const header = state.completionPromise
            ? `[Ralph loop iteration ${state.iteration}/${state.maxIterations || "∞"}. To complete: output "${state.completionPromise}" ONLY when genuinely true.]`
            : `[Ralph loop iteration ${state.iteration}/${state.maxIterations || "∞"}.]`;

          return `${header}\n\n=== PROMPT (iteration ${state.iteration}) ===\n${state.prompt}`;
        }

        case "cancel": {
          const state = await loadState();
          if (!state || !state.active) {
            return "No active Ralph loop found.";
          }

          const iteration = state.iteration;
          await clearState();

          return `Ralph loop cancelled (was at iteration ${iteration}). State file removed.`;
        }

        case "status": {
          const state = await loadState();
          if (!state || !state.active) {
            return "No active Ralph loop. Use action='start' to begin one.";
          }

          const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
          const sinceLast = Math.round(
            (Date.now() - state.lastIterationAt) / 1000,
          );

          return JSON.stringify(
            {
              active: true,
              iteration: state.iteration,
              maxIterations: state.maxIterations,
              completionPromise: state.completionPromise,
              startedAt: new Date(state.startedAt).toISOString(),
              elapsedSeconds: elapsed,
              secondsSinceLastIteration: sinceLast,
              prompt:
                state.prompt.substring(0, 200) +
                (state.prompt.length > 200 ? "..." : ""),
              stateFile: getStatePath(),
            },
            null,
            2,
          );
        }

        default:
          return `Unknown action '${action}'. Use start, next, cancel, or status.`;
      }
    } catch (error: any) {
      return `Error in ralph loop: ${error.message}`;
    }
  },
};
