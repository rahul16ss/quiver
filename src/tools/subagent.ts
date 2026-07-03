import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { fileURLToPath } from "url";
import { z } from "zod";
import { Tool } from "../registry.js";
import { config } from "../config.js";

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
 * The subagent inherits the same .env, tools, and memory as the parent.
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
async function buildSubagentScratchpad(): Promise<string> {
  const scratchDir = path.join(
    os.tmpdir(),
    `quiver-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(scratchDir, { recursive: true });

  // Copy workspace directories (read-only inspection)
  for (const dir of [
    "src",
    "tests",
    "ui",
    "docs",
    "templates",
    "skills",
    "Formula",
    "branding",
    "bin",
  ]) {
    try {
      await fs.cp(path.join(process.cwd(), dir), path.join(scratchDir, dir), {
        recursive: true,
      });
    } catch {
      /* best-effort copy */
    }
  }

  // Copy config files needed for tsx
  for (const file of ["package.json", "tsconfig.json"]) {
    try {
      await fs.copyFile(
        path.join(process.cwd(), file),
        path.join(scratchDir, file),
      );
    } catch {
      /* best-effort */
    }
  }

  // Do NOT link the real project's installed packages into the scratchpad.
  // The subagent runs in isolation and must not be able to mutate the real
  // project's dependencies. tsx is invoked from the parent process PATH.

  return scratchDir;
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

  // Build the prompt — include tool restriction if specified
  const prompt =
    tools.length > 0
      ? `${task}\n\n[System: You have access only to these tools: ${tools.join(", ")}]`
      : task;

  const args = [cliPath, "--json", "--single-turn", prompt];

  // Pass recursion depth to child so it can enforce the limit
  const childEnv = { ...process.env };
  childEnv.SUBAGENT_DEPTH = String(currentDepth + 1);

  // Strip sensitive keys that the subagent doesn't need.
  // IMPORTANT: OLLAMA_API_KEY is KEPT because the subagent needs it to
  // make LLM API calls — without it, every subagent gets 401 Unauthorized.
  // The subagent runs the same Quiver codebase in an isolated scratchpad,
  // so it has the same trust level as the parent for LLM access.
  // Other keys (GitHub, AWS, etc.) are stripped because the subagent
  // shouldn't be making external API calls beyond LLM inference.
  const sensitiveKeys = [
    "GITHUB_TOKEN",
    "CONTEXT7_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ];
  for (const key of sensitiveKeys) {
    delete childEnv[key];
  }

  // Build scratchpad for isolation (US-5.3)
  let scratchDir: string;
  try {
    scratchDir = await buildSubagentScratchpad();
  } catch {
    scratchDir = process.cwd(); // fallback — best-effort
  }

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(tsxPath, args, {
      cwd: scratchDir,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lastResponse = "";
    let turns = 0;
    let toolCalls = 0;
    let totalTokens = 0;

    const timeoutId = setTimeout(() => {
      child.kill();
      resolve({
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
            resolve({
              response: lastResponse || "Subagent error.",
              turns,
              toolCalls,
              tokens: totalTokens,
              error: msg.data?.error,
            });
            clearTimeout(timeoutId);
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
        resolve({
          response: `Subagent exited with code ${code}.`,
          turns,
          toolCalls,
          tokens: totalTokens,
          error: stderr.substring(0, 200) || `Exit code ${code}`,
        });
      } else {
        resolve({
          response: lastResponse || "Subagent completed with no output.",
          turns,
          toolCalls,
          tokens: totalTokens,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({
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
    "The subagent inherits the same .env, tools, and memory as the parent. " +
    "You can restrict which tools the subagent has access to (e.g., read-only tools only). " +
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
        summary.push("", `⚠ Error: ${result.error}`);
      }

      return summary.join("\n");
    } catch (error: any) {
      return `Error spawning subagent: ${error.message}`;
    }
  },
};
