import type { ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { fileURLToPath } from "url";
import { z } from "zod";
import { Tool } from "../registry.js";
import { config } from "../config.js";
import { createIsolatedEnv, spawnIsolatedProcess } from "../subagents/isolation.js";

/**
 * Subagent — spawn an isolated agent process for a delegated task.
 *
 * The subagent runs in a separate process with its own context window.
 * It receives a task prompt, works autonomously, and returns a single
 * text result. The parent agent doesn't see the subagent's intermediate
 * tool calls — only the final summary.
 *
 * Use cases:
 * - Parallel research (fan out multiple searches)
 * - Isolated exploration (keep heavy reads out of main context)
 * - Specialized tasks (code review, test writing, documentation)
 *
 * The subagent receives a copy of the user's workspace and an explicitly
 * scoped tool catalog. The real workspace is not exposed; only the minimum
 * model configuration needed to complete the delegated task is passed.
 * It runs in --json mode and the parent collects the final response.
 *
 * Inspired by Claude Code's Agent tool and Every's fan-out review pattern.
 */

const MAX_SUBAGENT_TURNS = 50;
const SUBAGENT_TIMEOUT_MS = 300000; // 5 minutes
const MAX_RECURSION_DEPTH = 2;

function getCliPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "cli.ts");
}

function getTsxPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, "..", "..");
  return path.join(projectRoot, "node_modules", ".bin", "tsx");
}

interface SubagentResult {
  response: string;
  turns: number;
  toolCalls: number;
  tokens: number;
  error?: string;
}

/**
 * Build a copy-on-write scratchpad directory for subagent isolation.
 * The subagent runs in an isolated copy of the workspace so it cannot
 * mutate the real project files (US-5.3 scratchpad isolation).
 */
async function buildSubagentScratchpad(workspaceRoot: string): Promise<string> {
  const scratchDir = path.join(
    os.tmpdir(),
    `quiver-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(scratchDir, { recursive: true });

  const workspaceSnapshot = path.join(scratchDir, "workspace");
  await fs.cp(workspaceRoot, workspaceSnapshot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(workspaceRoot, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      // Keep engagement configuration and user material, but do not clone
      // operational history, caches, dependencies, or backup copies.
      return !parts.some(
        (part, index) =>
          part === "node_modules" ||
          part === ".git" ||
          part === ".quiver-backups" ||
          (parts[0] === ".quiver" &&
            (part === ".sessions" || part === "workflow-runs")) ||
          (index === 0 && part === ".DS_Store"),
      );
    },
  });

  // The Quiver runtime and tsx executable remain installed by the parent;
  // only the user's workspace is copied into the child working directory.
  return workspaceSnapshot;
}

async function runSubagent(
  task: string,
  tools: string[],
): Promise<SubagentResult> {
  // Recursion depth check — prevent fork-bombs (US-5.3)
  const currentDepth = parseInt(process.env.SUBAGENT_DEPTH || "0", 10);
  if (currentDepth >= MAX_RECURSION_DEPTH) {
    return {
      response: `Subagent recursion depth limit (${MAX_RECURSION_DEPTH}) reached — cannot spawn child.`,
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      error: "Recursion limit",
    };
  }

  const cliPath = getCliPath();
  const tsxPath = getTsxPath();

  // Build the delegated prompt. The child receives the canonical Quiver system
  // prompt as well; this wrapper keeps the task role and result boundary clear.
  const prompt =
    `Delegated Quiver task:\n${task}\n\n` +
    "Return a concise result with sources, assumptions, unresolved items, and " +
    "recommended next steps. This is research or draft material; do not claim " +
    "independent approval or final sign-off.\n" +
    (tools.length > 0
      ? `\n[Harness constraint: this child may use only these tools: ${tools.join(", ")}]`
      : "");

  const args = [cliPath, "--json", "--single-turn", prompt];

  // Pass recursion depth to child so it can enforce the limit
  // Build a minimal env for the subagent — only what it needs to run the
  // LLM and Quiver's own config. Do NOT spread process.env (which carries
  // every secret the parent has). This mirrors the checker's minimal-env
  // pattern (src/subagents/checker.ts:496-505).
  const ALLOWED_ENV_KEYS = [
    "PATH", "HOME", "USER", "LANG", "TERM", "TZ",
    "LLM_API_KEY", "LLM_API_BASE_URL", "LLM_MODEL_NAME",
    "LLM_TEMPERATURE", "LLM_TOP_P", "LLM_TOP_K", "LLM_REASONING_EFFORT",
    // Vertex AI BYOK — child must bill the same customer project as parent.
    "VERTEX_PROJECT_ID", "VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT",
    // Checker route (maker-checker children / nested verify).
    "CHECKER_LLM_MODEL_NAME", "CHECKER_LLM_API_BASE_URL", "CHECKER_LLM_API_KEY",
    "QUIVER_CHECKER_REMOTE_APPROVED",
    "QUIVER_PROJECT_NAME", "QUIVER_MAX_CONTEXT_TOKENS",
    "QUIVER_SESSION_LOG", "QUIVER_SESSION_LOG_MAX_CHARS",
    "QUIVER_AMBIENT", "QUIVER_OUTPUT_MODE", "QUIVER_PROFILE",
    "QUIVER_CONSENT_GATE", "QUIVER_EVIDENCE_REQUIRED",
    "QUIVER_OFFICECLI_PATH", "QUIVER_AUTONOMY",
    "QUIVER_SUBAGENT_TOOLS",
    "SUBAGENT_DEPTH",
  ];
  // Build scratchpad for isolation (US-5.3)
  let scratchDir: string;
  try {
    scratchDir = await buildSubagentScratchpad(process.cwd());
  } catch (error: any) {
    return {
      response: "Subagent refused: could not create an isolated workspace copy.",
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      error: error?.message || String(error),
    };
  }

  const protectedDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const childEnv = createIsolatedEnv(ALLOWED_ENV_KEYS, {
    scratchDir,
    protectedDir,
    overrides: {
      SUBAGENT_DEPTH: String(currentDepth + 1),
      ...(tools.length > 0
        ? { QUIVER_SUBAGENT_TOOLS: tools.join(",") }
        : {}),
    },
  });

  return new Promise((resolve) => {
    const child: ChildProcess = spawnIsolatedProcess(tsxPath, args, {
      cwd: scratchDir,
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let lastResponse = "";
    let turns = 0;
    let toolCalls = 0;
    let totalTokens = 0;
    let settled = false;

    const finish = (result: SubagentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      child.kill();
      finish({
        response: lastResponse || "Subagent timed out.",
        turns,
        toolCalls,
        tokens: totalTokens,
        error: "Timeout",
      });
    }, SUBAGENT_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "token" && msg.data?.text) {
            lastResponse += msg.data.text;
          }
          if (msg.type === "tool_call") {
            toolCalls++;
            if (toolCalls >= MAX_SUBAGENT_TURNS) {
              child.kill();
              finish({
                response:
                  lastResponse ||
                  "Subagent stopped after reaching its bounded tool-call budget.",
                turns,
                toolCalls,
                tokens: totalTokens,
                error: `Tool-call budget (${MAX_SUBAGENT_TURNS}) exhausted`,
              });
              return;
            }
          }
          if (msg.type === "done") {
            turns = msg.data?.tokenStats?.turns || 0;
            toolCalls = msg.data?.tokenStats?.toolCalls || toolCalls;
            totalTokens =
              (msg.data?.tokenStats?.inputTokens || 0) +
              (msg.data?.tokenStats?.outputTokens || 0);
            if (msg.data?.response) {
              lastResponse = msg.data.response;
            }
          }
          if (msg.type === "error") {
            finish({
              response: lastResponse || "Subagent error.",
              turns,
              toolCalls,
              tokens: totalTokens,
              error: msg.data?.error,
            });
            child.kill();
          }
        } catch {
          // Non-JSON line — ignore
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("exit", (code) => {
      clearTimeout(timeoutId);
      if (code !== 0 && !lastResponse) {
        finish({
          response: `Subagent exited with code ${code}.`,
          turns,
          toolCalls,
          tokens: totalTokens,
          error: stderr.substring(0, 200) || `Exit code ${code}`,
        });
      } else {
        finish({
          response: lastResponse || "Subagent completed with no output.",
          turns,
          toolCalls,
          tokens: totalTokens,
        });
      }
    });

    child.on("error", (err) => {
      finish({
        response: `Failed to spawn subagent: ${err.message}`,
        turns: 0,
        toolCalls: 0,
        tokens: 0,
        error: err.message,
      });
    });
  });
}

export const tool: Tool = {
  name: "subagent",
  description:
    "Spawns an isolated agent process for a delegated task. The subagent has its own context window, works autonomously, and returns a single text result. " +
    "Use for parallel research, isolated exploration, or specialized tasks (code review, test writing). " +
    "The parent agent doesn't see the subagent's intermediate tool calls — only the final summary. " +
    "The subagent receives a copy of the current workspace and a minimal environment; parent secrets and the real workspace are not exposed. " +
    "You can restrict which tools the subagent has access to, and that allowlist is enforced in the child runtime (e.g., read-only tools only). " +
    "Do NOT use for simple tasks — only when isolation or parallelism is needed.",
  parameters: z.object({
    task: z
      .string()
      .describe(
        "The task prompt for the subagent. Be specific about what you want — the subagent has no context from your conversation.",
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of tool names the subagent can use. If omitted, the subagent has access to all tools. " +
          "Example: ['view_file', 'grep_search', 'list_dir'] for read-only exploration. " +
          "Example: ['view_file', 'write_file', 'replace_content', 'run_tests'] for code changes.",
      ),
  }),
  execute: async ({ task, tools }) => {
    try {
      const result = await runSubagent(task, tools || []);

      const summary = [
        `Subagent completed: ${result.turns} turns, ${result.toolCalls} tool calls, ~${result.tokens.toLocaleString()} tokens.`,
        "",
        result.response,
      ];

      if (result.error) {
        summary.push("", `Error: ${result.error}`);
      }

      return summary.join("\n");
    } catch (error: any) {
      return `Error spawning subagent: ${error.message}`;
    }
  },
};
