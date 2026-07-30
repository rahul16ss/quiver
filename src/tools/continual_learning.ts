import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { getProjectSessionsDir } from "../paths.js";
import {
  createMemoryFact,
  appendMemoryFact,
  readAllMemoryFacts,
  type MemoryType,
} from "../memory/schema.js";

/**
 * Continual Learning — mines session transcripts for high-signal patterns
 * (repeated user corrections, durable workspace facts) and enqueues them as
 * PENDING MemoryFact records in the structured memory pipeline (facts.jsonl).
 *
 * This is the unified learning pipeline: extracted signals flow through the
 * same review queue (accept/edit/reject/pin/expire) as every other memory
 * fact, with full provenance, decay scoring, and citation tracking. Only
 * reviewed (accepted) facts enter active prompt assembly.
 *
 * Design principles:
 * 1. TRANSPARENCY: Shows the user exactly what was learned before enqueuing.
 * 2. CADENCE: Only triggers after N turns and M minutes (configurable).
 * 3. INCREMENTAL: Uses an index to only process new/changed session files.
 * 4. UNIFIED: Enqueues MemoryFact records, not parallel Markdown files.
 * 5. REVIEW-GATED: Nothing enters active context until the user accepts it.
 *
 * State files:
 * - .sessions/continual-learning-cadence.json — cadence state
 * - .sessions/continual-learning-index.json — incremental transcript index
 * Memory facts: facts.jsonl (via schema.ts) — pending until reviewed.
 */

interface CadenceState {
  version: number;
  lastRunAtMs: number;
  lastRunTurns: number;
}

interface TranscriptIndex {
  [filename: string]: { mtime: number; processed: boolean };
}

const DEFAULT_MIN_TURNS = 10;
const DEFAULT_MIN_MINUTES = 120;

function getCadenceStatePath(): string {
  return path.join(getProjectSessionsDir(), "continual-learning-cadence.json");
}

function getIndexPath(): string {
  return path.join(getProjectSessionsDir(), "continual-learning-index.json");
}

async function loadCadenceState(): Promise<CadenceState> {
  try {
    const content = await fs.readFile(getCadenceStatePath(), "utf8");
    return JSON.parse(content);
  } catch {
    return { version: 1, lastRunAtMs: 0, lastRunTurns: 0 };
  }
}

async function saveCadenceState(state: CadenceState): Promise<void> {
  const p = getCadenceStatePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(state, null, 2), "utf8");
}

async function loadIndex(): Promise<TranscriptIndex> {
  try {
    const content = await fs.readFile(getIndexPath(), "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveIndex(index: TranscriptIndex): Promise<void> {
  const p = getIndexPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(index, null, 2), "utf8");
}

/**
 * Count total turns across all session log files.
 */
async function countTotalTurns(): Promise<number> {
  const sessionsDir = getProjectSessionsDir();
  let totalTurns = 0;
  try {
    const files = await fs.readdir(sessionsDir);
    for (const f of files) {
      if (!f.startsWith("session_") || !f.endsWith(".json")) continue;
      try {
        const content = await fs.readFile(path.join(sessionsDir, f), "utf8");
        const events = JSON.parse(content);
        if (Array.isArray(events)) {
          totalTurns += events.filter(
            (e: any) => e.type === "turn_start",
          ).length;
        }
      } catch {
        // Skip corrupt files
      }
    }
  } catch {
    // No sessions dir
  }
  return totalTurns;
}

/**
 * Find new or changed session log files since the last index update.
 */
async function findChangedTranscripts(
  index: TranscriptIndex,
): Promise<string[]> {
  const sessionsDir = getProjectSessionsDir();
  const changed: string[] = [];
  try {
    const files = await fs.readdir(sessionsDir);
    for (const f of files) {
      if (!f.startsWith("session_") || !f.endsWith(".json")) continue;
      const fullPath = path.join(sessionsDir, f);
      try {
        const stat = await fs.stat(fullPath);
        const indexed = index[f];
        if (!indexed || stat.mtimeMs > indexed.mtime) {
          changed.push(f);
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // No sessions dir
  }
  return changed;
}

interface ExtractedSignal {
  type: MemoryType;
  content: string;
  sourceSession: string;
}

/**
 * Extract high-signal patterns from session log events and map them to
 * typed MemoryFact candidates. Each signal becomes a PENDING fact in
 * facts.jsonl — the user reviews it via /memory review before it enters
 * active context.
 */
function extractPatternsFromEvents(
  events: any[],
  sessionFilename: string,
): ExtractedSignal[] {
  const signals: ExtractedSignal[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.type === "user_input" && event.data?.content) {
      const content = String(event.data.content).toLowerCase();

      // Detect correction patterns → user_preference
      if (
        content.includes("no, ") ||
        content.includes("don't ") ||
        content.includes("actually, ") ||
        content.includes("instead, ") ||
        content.includes("i prefer ") ||
        content.includes("always use ") ||
        content.includes("never use ")
      ) {
        const text = String(event.data.content).trim();
        if (text.length > 10 && text.length < 200) {
          signals.push({
            type: "user_preference",
            content: text,
            sourceSession: sessionFilename,
          });
        }
      }

      // Detect workspace fact patterns → workspace_fact
      if (
        content.includes("the project uses ") ||
        content.includes("we use ") ||
        content.includes("the build command is ") ||
        (content.includes("run ") && content.includes("to test"))
      ) {
        const text = String(event.data.content).trim();
        if (text.length > 10 && text.length < 200) {
          signals.push({
            type: "workspace_fact",
            content: text,
            sourceSession: sessionFilename,
          });
        }
      }
    }

    // Detect build/test commands in tool results → workspace_fact
    if (event.type === "tool_result" && event.data?.tool === "run_command") {
      const result = String(event.data?.result || "");
      if (result.includes("npm test") || result.includes("npx tsc")) {
        signals.push({
          type: "workspace_fact",
          content: `Build/test command: ${result.split("\n")[0].substring(0, 100)}`,
          sourceSession: sessionFilename,
        });
      }
    }
  }

  return signals;
}

export const tool: Tool = {
  name: "continual_learning",
  description:
    "Mines session transcripts for high-signal patterns (repeated user corrections, durable workspace facts) and enqueues them as PENDING memory facts in the structured memory pipeline (facts.jsonl). " +
    "Extracted facts flow through the same review queue as every other memory fact — the user accepts, edits, or rejects each one via /memory review before it enters active context. " +
    "Uses cadence control (min turns + min minutes since last run) and an incremental index. " +
    "TRANSPARENT: shows exactly what was learned before enqueuing. " +
    "Use this when you want to learn from past sessions and keep memory up to date automatically.",
  parameters: z.object({
    action: z
      .enum(["check", "run", "status", "reset"])
      .optional()
      .describe(
        "Action: 'check' to see if cadence allows a run (default), 'run' to force a learning cycle, 'status' to show current state, 'reset' to clear cadence and index.",
      ),
    minTurns: z
      .number()
      .optional()
      .describe(
        `Minimum completed turns since last run. Default: ${DEFAULT_MIN_TURNS}.`,
      ),
    minMinutes: z
      .number()
      .optional()
      .describe(
        `Minimum minutes since last run. Default: ${DEFAULT_MIN_MINUTES}.`,
      ),
  }),
  execute: async ({ action, minTurns, minMinutes }) => {
    const minT = minTurns || DEFAULT_MIN_TURNS;
    const minM = minMinutes || DEFAULT_MIN_MINUTES;
    const act = action || "check";

    try {
      switch (act) {
        case "reset": {
          await saveCadenceState({
            version: 1,
            lastRunAtMs: 0,
            lastRunTurns: 0,
          });
          await saveIndex({});
          return "Continual learning state reset. Cadence and index cleared.";
        }

        case "status": {
          const state = await loadCadenceState();
          const index = await loadIndex();
          const totalTurns = await countTotalTurns();
          const now = Date.now();
          const minutesSinceLastRun =
            state.lastRunAtMs > 0
              ? Math.round((now - state.lastRunAtMs) / 60000)
              : -1;
          const turnsSinceLastRun = totalTurns - state.lastRunTurns;
          const existingFacts = await readAllMemoryFacts();
          const pendingFacts = existingFacts.filter((f) => !f.reviewed);

          return JSON.stringify(
            {
              cadence: {
                lastRunAt:
                  state.lastRunAtMs > 0
                    ? new Date(state.lastRunAtMs).toISOString()
                    : "never",
                minutesSinceLastRun,
                turnsSinceLastRun,
                minTurnsRequired: minT,
                minMinutesRequired: minM,
                canRun:
                  turnsSinceLastRun >= minT && minutesSinceLastRun >= minM,
              },
              index: {
                totalTranscripts: Object.keys(index).length,
                processed: Object.values(index).filter((v) => v.processed)
                  .length,
              },
              totalTurns,
              memoryPipeline: {
                totalFacts: existingFacts.length,
                pendingReview: pendingFacts.length,
                reviewed: existingFacts.length - pendingFacts.length,
              },
            },
            null,
            2,
          );
        }

        case "check": {
          const state = await loadCadenceState();
          const totalTurns = await countTotalTurns();
          const now = Date.now();
          const minutesSinceLastRun =
            state.lastRunAtMs > 0
              ? (now - state.lastRunAtMs) / 60000
              : Infinity;
          const turnsSinceLastRun = totalTurns - state.lastRunTurns;

          const canRun =
            turnsSinceLastRun >= minT && minutesSinceLastRun >= minM;

          return JSON.stringify(
            {
              canRun,
              turnsSinceLastRun,
              minTurnsRequired: minT,
              minutesSinceLastRun: Math.round(minutesSinceLastRun),
              minMinutesRequired: minM,
              message: canRun
                ? "Cadence allows a learning run. Use action='run' to trigger."
                : `Not enough activity since last run. Need ${minT - turnsSinceLastRun} more turns and ${Math.max(0, minM - Math.round(minutesSinceLastRun))} more minutes.`,
            },
            null,
            2,
          );
        }

        case "run": {
          const state = await loadCadenceState();
          const index = await loadIndex();
          const totalTurns = await countTotalTurns();

          const changedFiles = await findChangedTranscripts(index);

          if (changedFiles.length === 0) {
            await saveCadenceState({
              version: 1,
              lastRunAtMs: Date.now(),
              lastRunTurns: totalTurns,
            });
            return "No new or changed session transcripts to process. Cadence state updated.";
          }

          // Process each changed transcript and collect extracted signals
          const allSignals: ExtractedSignal[] = [];
          const sessionsDir = getProjectSessionsDir();

          for (const filename of changedFiles) {
            try {
              const content = await fs.readFile(
                path.join(sessionsDir, filename),
                "utf8",
              );
              const events = JSON.parse(content);
              if (Array.isArray(events)) {
                const signals = extractPatternsFromEvents(events, filename);
                allSignals.push(...signals);
              }
              const stat = await fs.stat(path.join(sessionsDir, filename));
              index[filename] = { mtime: stat.mtimeMs, processed: true };
            } catch {
              // Skip corrupt files
            }
          }

          // Deduplicate against existing facts (avoid re-enqueuing the same
          // signal from a reprocessed transcript). Match on content prefix.
          const existingFacts = await readAllMemoryFacts();
          const existingContents = new Set(
            existingFacts.map((f) => f.content.substring(0, 60).toLowerCase()),
          );
          const newSignals = allSignals.filter(
            (s) =>
              !existingContents.has(s.content.substring(0, 60).toLowerCase()),
          );

          // Enqueue each new signal as a PENDING MemoryFact
          let enqueued = 0;
          for (const signal of newSignals) {
            const fact = createMemoryFact({
              type: signal.type,
              content: signal.content,
              source_session: signal.sourceSession,
              confidence: "low", // extracted signals start low-confidence; the user can pin to raise it
              privacy: "project",
            });
            await appendMemoryFact(fact);
            enqueued++;
          }

          // Save state
          await saveCadenceState({
            version: 1,
            lastRunAtMs: Date.now(),
            lastRunTurns: totalTurns,
          });
          await saveIndex(index);

          // Build transparency report
          const report: string[] = [];
          report.push("╔══ Continual Learning Report ════════════════════╗");
          report.push(
            `║  Processed ${changedFiles.length} new/changed transcript(s)`,
          );
          report.push(
            `║  Extracted ${allSignals.length} signal(s), ${newSignals.length} new (not already in facts.jsonl)`,
          );
          report.push(`║  Enqueued ${enqueued} pending fact(s) for review`);
          report.push("║");
          report.push("║  Pending facts are reviewed via /memory review.");
          report.push("║  Nothing enters active context until you accept it.");

          if (newSignals.length > 0) {
            report.push("║");
            report.push("║  New signals enqueued:");
            for (const s of newSignals.slice(0, 12)) {
              report.push(`║  • [${s.type}] ${s.content.substring(0, 70)}`);
            }
            if (newSignals.length > 12) {
              report.push(`║  … and ${newSignals.length - 12} more`);
            }
          }

          report.push("╚════════════════════════════════════════════════╝");

          const message =
            enqueued === 0
              ? "No new signals — all extracted patterns were already in facts.jsonl. Cadence state updated."
              : `Enqueued ${enqueued} pending fact(s) in facts.jsonl. Review them with /memory review.`;

          return `${report.join("\n")}\n\n${message}`;
        }

        default:
          return `Unknown action '${act}'. Use check, run, status, or reset.`;
      }
    } catch (error: any) {
      return `Error in continual learning: ${error.message}`;
    }
  },
};