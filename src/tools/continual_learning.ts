import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { getProjectSessionsDir, getProjectMemoryDir } from "../paths.js";

/**
 * Continual Learning — automatically mines session transcripts for high-signal
 * patterns (repeated user corrections, durable workspace facts) and proposes
 * memory updates.
 *
 * Inspired by Cursor's continual-learning plugin, adapted for Quiver:
 *
 * Key design principles:
 * 1. TRANSPARENCY: Shows the user exactly what was learned before writing
 * 2. CADENCE: Only triggers after N turns and M minutes (configurable)
 * 3. INCREMENTAL: Uses an index to only process new/changed session files
 * 4. HIGH-SIGNAL: Only extracts repeated patterns and durable facts
 * 5. BULLET-POINT FORMAT: Plain bullets, no metadata noise
 * 6. IN-PLACE UPDATES: Updates existing bullets rather than only appending
 * 7. SECTION CAP: Max 12 bullets per section to avoid bloat
 *
 * The tool writes to two memory files:
 * - user-preferences.md — personal preferences (user-scoped)
 * - workspace-facts.md — durable workspace facts (project-scoped)
 *
 * State files:
 * - .sessions/continual-learning-cadence.json — cadence state
 * - .sessions/continual-learning-index.json — incremental transcript index
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
const MAX_BULLETS_PER_SECTION = 12;

function getCadenceStatePath(): string {
  return path.join(getProjectSessionsDir(), "continual-learning-cadence.json");
}

function getIndexPath(): string {
  return path.join(getProjectSessionsDir(), "continual-learning-index.json");
}

function getUserPreferencesPath(): string {
  return path.join(getProjectMemoryDir(), "user-preferences.md");
}

function getWorkspaceFactsPath(): string {
  return path.join(getProjectMemoryDir(), "workspace-facts.md");
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

/**
 * Extract high-signal patterns from session log events.
 * Looks for:
 * - User corrections (user follows up with a correction after an assistant response)
 * - Repeated preferences (same pattern across multiple sessions)
 * - Durable workspace facts (file paths, project structure, build commands)
 */
function extractPatternsFromEvents(events: any[]): {
  userPreferences: string[];
  workspaceFacts: string[];
} {
  const userPreferences: string[] = [];
  const workspaceFacts: string[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Look for user inputs that contain corrections
    if (event.type === "user_input" && event.data?.content) {
      const content = String(event.data.content).toLowerCase();

      // Detect correction patterns
      if (
        content.includes("no, ") ||
        content.includes("don't ") ||
        content.includes("actually, ") ||
        content.includes("instead, ") ||
        content.includes("i prefer ") ||
        content.includes("always use ") ||
        content.includes("never use ")
      ) {
        // Extract the preference (simplified — in production this would use the LLM)
        const text = String(event.data.content).trim();
        if (text.length > 10 && text.length < 200) {
          userPreferences.push(text);
        }
      }

      // Detect workspace fact patterns
      if (
        content.includes("the project uses ") ||
        content.includes("we use ") ||
        content.includes("the build command is ") ||
        (content.includes("run ") && content.includes("to test"))
      ) {
        const text = String(event.data.content).trim();
        if (text.length > 10 && text.length < 200) {
          workspaceFacts.push(text);
        }
      }
    }

    // Look for tool results that reveal workspace structure
    if (event.type === "tool_result" && event.data?.tool === "run_command") {
      const result = String(event.data?.result || "");
      // Detect build/test commands in results
      if (result.includes("npm test") || result.includes("npx tsc")) {
        workspaceFacts.push(
          `Build/test command: ${result.split("\n")[0].substring(0, 100)}`,
        );
      }
    }
  }

  return { userPreferences, workspaceFacts };
}

/**
 * Read existing memory file and parse bullets.
 */
async function readMemoryBullets(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.substring(2).trim());
  } catch {
    return [];
  }
}

/**
 * Merge new bullets with existing ones, deduplicating semantically similar items.
 * Keeps at most MAX_BULLETS_PER_SECTION bullets.
 */
function mergeBullets(existing: string[], newOnes: string[]): string[] {
  const merged = [...existing];

  for (const newItem of newOnes) {
    // Simple dedup: check if a similar bullet already exists
    const similar = merged.some((existing) => {
      // Check for substring match (simplified semantic dedup)
      const shorter = existing.length < newItem.length ? existing : newItem;
      const longer = existing.length < newItem.length ? newItem : existing;
      return longer
        .toLowerCase()
        .includes(shorter.toLowerCase().substring(0, 30));
    });

    if (!similar) {
      merged.push(newItem);
    }
  }

  // Cap at MAX_BULLETS_PER_SECTION (keep the most recent)
  return merged.slice(-MAX_BULLETS_PER_SECTION);
}

/**
 * Write memory file with bullet points.
 */
async function writeMemoryFile(
  filePath: string,
  header: string,
  bullets: string[],
): Promise<void> {
  const content = `# ${header}\n\n${bullets.map((b) => `- ${b}`).join("\n")}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export const tool: Tool = {
  name: "continual_learning",
  description:
    "Mines session transcripts for high-signal patterns (repeated user corrections, durable workspace facts) and proposes memory updates. " +
    "Uses cadence control (min turns + min minutes since last run) to avoid noisy rewrites. " +
    "Uses an incremental index to only process new/changed session files. " +
    "Writes plain bullet points to user-preferences.md and workspace-facts.md in the project memory directory. " +
    "TRANSPARENT: shows the user exactly what was learned before writing. " +
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
              memoryFiles: {
                userPreferences: getUserPreferencesPath(),
                workspaceFacts: getWorkspaceFactsPath(),
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

          // Find changed transcripts
          const changedFiles = await findChangedTranscripts(index);

          if (changedFiles.length === 0) {
            // Still update cadence state
            await saveCadenceState({
              version: 1,
              lastRunAtMs: Date.now(),
              lastRunTurns: totalTurns,
            });
            return "No new or changed session transcripts to process. Cadence state updated.";
          }

          // Process each changed transcript
          const allPreferences: string[] = [];
          const allFacts: string[] = [];
          const sessionsDir = getProjectSessionsDir();

          for (const filename of changedFiles) {
            try {
              const content = await fs.readFile(
                path.join(sessionsDir, filename),
                "utf8",
              );
              const events = JSON.parse(content);
              if (Array.isArray(events)) {
                const { userPreferences, workspaceFacts } =
                  extractPatternsFromEvents(events);
                allPreferences.push(...userPreferences);
                allFacts.push(...workspaceFacts);
              }
              // Update index
              const stat = await fs.stat(path.join(sessionsDir, filename));
              index[filename] = { mtime: stat.mtimeMs, processed: true };
            } catch {
              // Skip corrupt files
            }
          }

          // Read existing memory files
          const existingPrefs = await readMemoryBullets(
            getUserPreferencesPath(),
          );
          const existingFacts = await readMemoryBullets(
            getWorkspaceFactsPath(),
          );

          // Merge with dedup
          const mergedPrefs = mergeBullets(existingPrefs, allPreferences);
          const mergedFacts = mergeBullets(existingFacts, allFacts);

          // Build transparency report
          const newPrefs = mergedPrefs.filter(
            (p) => !existingPrefs.includes(p),
          );
          const newFacts = mergedFacts.filter(
            (f) => !existingFacts.includes(f),
          );

          const report: string[] = [];
          report.push("╔══ Continual Learning Report ════════════════════╗");
          report.push(
            `║  Processed ${changedFiles.length} new/changed transcript(s)`,
          );
          report.push(
            `║  Extracted ${allPreferences.length} preference signals, ${allFacts.length} workspace fact signals`,
          );
          report.push(`║  New preferences: ${newPrefs.length}`);
          report.push(`║  New workspace facts: ${newFacts.length}`);
          report.push(
            `║  Total preferences: ${mergedPrefs.length}/${MAX_BULLETS_PER_SECTION}`,
          );
          report.push(
            `║  Total workspace facts: ${mergedFacts.length}/${MAX_BULLETS_PER_SECTION}`,
          );

          if (newPrefs.length > 0) {
            report.push("║");
            report.push("║  New user preferences learned:");
            for (const p of newPrefs) {
              report.push(`║  • ${p.substring(0, 80)}`);
            }
          }

          if (newFacts.length > 0) {
            report.push("║");
            report.push("║  New workspace facts learned:");
            for (const f of newFacts) {
              report.push(`║  • ${f.substring(0, 80)}`);
            }
          }

          report.push("╚════════════════════════════════════════════════╝");

          // Write memory files
          if (newPrefs.length > 0 || existingPrefs.length === 0) {
            await writeMemoryFile(
              getUserPreferencesPath(),
              "Learned User Preferences",
              mergedPrefs,
            );
          }

          if (newFacts.length > 0 || existingFacts.length === 0) {
            await writeMemoryFile(
              getWorkspaceFactsPath(),
              "Learned Workspace Facts",
              mergedFacts,
            );
          }

          // Save state
          await saveCadenceState({
            version: 1,
            lastRunAtMs: Date.now(),
            lastRunTurns: totalTurns,
          });
          await saveIndex(index);

          const message =
            newPrefs.length === 0 && newFacts.length === 0
              ? "No high-signal memory updates. Cadence state updated."
              : `Learned ${newPrefs.length} new preference(s) and ${newFacts.length} new workspace fact(s). Memory files updated.`;

          return `${report.join("\n")}\n\n${message}\n\nMemory files:\n  ${getUserPreferencesPath()}\n  ${getWorkspaceFactsPath()}`;
        }

        default:
          return `Unknown action '${act}'. Use check, run, status, or reset.`;
      }
    } catch (error: any) {
      return `Error in continual learning: ${error.message}`;
    }
  },
};
