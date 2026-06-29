import { spawn, ChildProcess } from "child_process";
import * as path from "path";
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

async function runSubagent(task: string, tools: string[]): Promise<SubagentResult> {
  return new Promise((resolve) => {
    const cliPath = getCliPath();
    const tsxPath = getTsxPath();

    // Build the prompt — include tool restriction if specified
    const prompt = tools.length > 0
      ? `${task}\n\n[System: You have access only to these tools: ${tools.join(", ")}]`
      : task;

    const args = [cliPath, "--json", "--single-turn", prompt];

    const childEnv = { ...process.env };
    const sensitiveKeys = [
      "LLM_API_KEY",
      "PARALLEL_API_KEY",
      "OLLAMA_API_KEY",
      "GITHUB_TOKEN",
      "CONTEXT7_API_KEY",
      "API_KEY",
      "SECRET",
      "TOKEN",
      "PASSWORD",
      "PRIVATE_KEY",
      "ACCESS_KEY",
      "SECRET_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY"
    ];
    for (const key of sensitiveKeys) {
      delete childEnv[key];
    }

    const child: ChildProcess = spawn(tsxPath, args, {
      cwd: process.cwd(),
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
            totalTokens = (msg.data?.tokenStats?.inputTokens || 0) +
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