/**
 * Subagent Pool Manager — US-5.3
 *
 * Spawns child processes using separate sandboxed contexts with concurrency
 * limits and timeouts set by the parent.
 *
 * Subagents are constrained by a recursion limit check (depth ≤ 2) to
 * prevent fork-bombs.
 *
 * Parent synthesizes children results and serializes concurrent writes.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_SUBAGENT_CONFIG,
  type SubagentConfig,
  type SubagentTask,
  type SubagentResult,
} from "./types.js";
import {
  createScratchpad,
  cleanupScratchpad,
  validateSubagentFiles,
  mergeSubagentResults,
} from "./sandbox.js";

// ─── Pool Manager ────────────────────────────────────────────────────

export class SubagentPool {
  private config: SubagentConfig;
  private active: Map<string, ChildProcess> = new Map();
  private queue: { task: SubagentTask; resolve: (r: SubagentResult) => void; reject: (e: Error) => void }[] = [];

  constructor(config?: Partial<SubagentConfig>) {
    this.config = { ...DEFAULT_SUBAGENT_CONFIG, ...config };
  }

  /**
   * Check if a task is within the recursion depth limit.
   */
  canSpawn(recursionDepth: number): boolean {
    return recursionDepth <= this.config.maxRecursionDepth;
  }

  /**
   * Get the number of active subagents.
   */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Get the queue length.
   */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Execute a subagent task.
   * If concurrency limit is reached, the task is queued.
   */
  async execute(task: SubagentTask, workspaceRoot: string): Promise<SubagentResult> {
    // Check recursion depth
    if (!this.canSpawn(task.recursionDepth)) {
      return {
        taskId: task.id,
        success: false,
        output: "",
        error: `Recursion depth ${task.recursionDepth} exceeds maximum ${this.config.maxRecursionDepth}`,
        durationMs: 0,
        filesModified: [],
      };
    }

    // If at capacity, queue the task
    if (this.active.size >= this.config.maxConcurrency) {
      return new Promise((resolve, reject) => {
        this.queue.push({ task, resolve, reject });
      });
    }

    return this.runTask(task, workspaceRoot);
  }

  /**
   * Run a single subagent task.
   */
  private async runTask(task: SubagentTask, workspaceRoot: string): Promise<SubagentResult> {
    const startTime = Date.now();
    const scratchpad = await createScratchpad(task.id, workspaceRoot, this.config);

    try {
      // Spawn the subagent as a child process
      // The child process runs the Quiver CLI in JSON mode with the task prompt
      const result = await this.spawnSubagent(task, scratchpad);

      // Validate and merge results
      if (result.success && result.filesModified.length > 0) {
        const { valid, invalid } = validateSubagentFiles(
          result.filesModified,
          workspaceRoot,
          [],
          scratchpad,
        );

        if (invalid.length > 0) {
          result.output += `\n\nWarning: ${invalid.length} file(s) were blocked from merging (outside workspace or blocked pattern).`;
        }

        if (valid.length > 0) {
          const { merged, errors } = await mergeSubagentResults(
            task.id,
            valid,
            workspaceRoot,
            this.config,
          );

          if (errors.length > 0) {
            result.output += `\n\nMerge errors: ${errors.join("; ")}`;
          }

          result.filesModified = merged;
        }
      }

      return result;
    } catch (error: any) {
      return {
        taskId: task.id,
        success: false,
        output: "",
        error: error.message,
        durationMs: Date.now() - startTime,
        filesModified: [],
      };
    } finally {
      // Clean up scratchpad
      await cleanupScratchpad(task.id, workspaceRoot, this.config);

      // Process queue
      this.processQueue(workspaceRoot);
    }
  }

  /**
   * Spawn a subagent child process.
   */
  private async spawnSubagent(task: SubagentTask, scratchpad: string): Promise<SubagentResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      // Build the command to run the subagent
      // Uses the Quiver CLI in JSON mode with the task prompt
      const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
      const tsxPath = path.resolve("node_modules/.bin/tsx");

      const args = [
        cliPath,
        "--json",
        "--quiet",
        "--single-turn", task.prompt,
      ];

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

      const child = spawn(tsxPath, args, {
        cwd: scratchpad,
        env: {
          ...childEnv,
          QUIVER_SUBAGENT_DEPTH: String(task.recursionDepth),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.active.set(task.id, child);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, task.timeoutMs);

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        this.active.delete(task.id);

        const durationMs = Date.now() - startTime;
        const filesModified = extractModifiedFiles(stdout);

        if (timedOut) {
          resolve({
            taskId: task.id,
            success: false,
            output: stdout,
            error: "Subagent timed out",
            durationMs,
            filesModified,
          });
        } else if (code === 0) {
          resolve({
            taskId: task.id,
            success: true,
            output: stdout,
            durationMs,
            filesModified,
          });
        } else {
          resolve({
            taskId: task.id,
            success: false,
            output: stdout,
            error: stderr || `Subagent exited with code ${code}`,
            durationMs,
            filesModified,
          });
        }
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        this.active.delete(task.id);
        resolve({
          taskId: task.id,
          success: false,
          output: "",
          error: error.message,
          durationMs: Date.now() - startTime,
          filesModified: [],
        });
      });
    });
  }

  /**
   * Process the next queued task.
   */
  private processQueue(workspaceRoot: string): void {
    if (this.queue.length === 0 || this.active.size >= this.config.maxConcurrency) {
      return;
    }

    const next = this.queue.shift();
    if (next) {
      this.runTask(next.task, workspaceRoot)
        .then(next.resolve)
        .catch(next.reject);
    }
  }

  /**
   * Cancel all active subagents.
   */
  cancelAll(): void {
    for (const child of this.active.values()) {
      child.kill("SIGTERM");
    }
    this.active.clear();

    // Reject all queued tasks
    for (const item of this.queue) {
      item.reject(new Error("Subagent pool cancelled"));
    }
    this.queue = [];
  }
}

/**
 * Extract modified file paths from subagent output.
 * Looks for file path patterns in the output.
 */
function extractModifiedFiles(output: string): string[] {
  const files: string[] = [];
  const patterns = [
    /File successfully written to (.+)/g,
    /Successfully replaced.*in (.+)\./g,
    /Created file: (.+)/g,
    /Modified file: (.+)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(output)) !== null) {
      files.push(match[1].trim());
    }
  }

  return [...new Set(files)];
}