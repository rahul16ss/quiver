/**
 * Tool Runtime — JIT Compilation & Hot-Reloading — US-5.2
 *
 * Tools are compiled dynamically using an ultra-fast transpiler (esbuild)
 * in <200ms instead of raw tsc CLI commands.
 * Hot-reloading is leak-free, recycling worker threads rather than
 * appending cache-busting ESM query strings.
 *
 * Generated tools are disabled by default; the user must inspect and
 * approve tool source code and permissions before activation.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Worker } from "worker_threads";
import { execSync } from "child_process";
import { getProjectToolsDir } from "../paths.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface ToolApproval {
  toolName: string;
  sourceHash: string;
  approved: boolean;
  approvedAt: string;
  permissions: string[];
}

export interface CompilationResult {
  success: boolean;
  compiledPath: string | null;
  error?: string;
  durationMs: number;
}

export interface ToolMetadata {
  name: string;
  sourcePath: string;
  sourceHash: string;
  compiledPath: string;
  approved: boolean;
  createdAt: string;
  permissions: string[];
}

// ─── JIT Compilation ─────────────────────────────────────────────────

/**
 * Compile TypeScript tool source to JavaScript using esbuild.
 * Target: <200ms compilation time.
 *
 * @param sourceCode - TypeScript source code
 * @param toolName - Tool name for file naming
 * @returns Compilation result with compiled path or error
 */
export async function compileTool(
  sourceCode: string,
  toolName: string,
): Promise<CompilationResult> {
  const startTime = Date.now();
  const toolsDir = getProjectToolsDir();
  const sourcePath = path.join(toolsDir, `${toolName}.ts`);
  const compiledPath = path.join(toolsDir, `${toolName}.mjs`);

  // Ensure tools directory exists
  await fs.mkdir(toolsDir, { recursive: true });

  // Write source file
  await fs.writeFile(sourcePath, sourceCode, "utf8");

  // Try esbuild first (fastest)
  try {
    const esbuildBin = findEsbuild();
    if (esbuildBin) {
      execSync(
        `${esbuildBin} ${sourcePath} --bundle --format=esm --platform=node --outfile=${compiledPath}`,
        { stdio: "pipe", timeout: 5000 },
      );

      const durationMs = Date.now() - startTime;
      if (durationMs > 200) {
        // Log warning if compilation took too long
        console.warn(`Tool compilation took ${durationMs}ms (target: <200ms)`);
      }

      return { success: true, compiledPath, durationMs };
    }
  } catch (error: any) {
    // esbuild failed — fall back to tsx transpilation
  }

  // Fallback: use TypeScript compiler API directly (slower but reliable)
  try {
    const ts = await import("typescript");
    const result = ts.transpileModule(sourceCode, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        strict: false,
      },
    });

    if (result.diagnostics && result.diagnostics.length > 0) {
      const errors = result.diagnostics
        .map((d: any) => d.messageText)
        .join("; ");
      return { success: false, compiledPath: null, error: errors, durationMs: Date.now() - startTime };
    }

    await fs.writeFile(compiledPath, result.outputText, "utf8");
    return { success: true, compiledPath, durationMs: Date.now() - startTime };
  } catch (error: any) {
    return {
      success: false,
      compiledPath: null,
      error: `Compilation failed: ${error.message}`,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Find the esbuild binary path.
 */
function findEsbuild(): string | null {
  try {
    // Try local node_modules first
    const localEsbuild = path.resolve("node_modules/.bin/esbuild");
    if (fsSync.existsSync(localEsbuild)) return localEsbuild;

    // Try global
    const which = process.platform === "win32" ? "where" : "which";
    const result = execSync(`${which} esbuild`, { stdio: "pipe", encoding: "utf8" });
    return result.trim();
  } catch {
    return null;
  }
}

// ─── Tool Approval ───────────────────────────────────────────────────

const APPROVALS_FILE = "tool_approvals.json";

/**
 * Get the path to the tool approvals file.
 */
function getApprovalsPath(): string {
  return path.join(getProjectToolsDir(), APPROVALS_FILE);
}

/**
 * Load tool approvals from disk.
 */
async function loadApprovals(): Promise<Record<string, ToolApproval>> {
  try {
    const content = await fs.readFile(getApprovalsPath(), "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Save tool approvals to disk.
 */
async function saveApprovals(approvals: Record<string, ToolApproval>): Promise<void> {
  const approvalsPath = getApprovalsPath();
  await fs.mkdir(path.dirname(approvalsPath), { recursive: true });
  await fs.writeFile(approvalsPath, JSON.stringify(approvals, null, 2), "utf8");
}

/**
 * Check if a tool has been approved by the user.
 *
 * @param toolName - Tool name
 * @param sourceHash - SHA-256 hash of the source code
 * @returns True if the tool is approved with this exact source hash
 */
export async function isToolApproved(toolName: string, sourceHash: string): Promise<boolean> {
  const approvals = await loadApprovals();
  const approval = approvals[toolName];
  return approval?.approved === true && approval?.sourceHash === sourceHash;
}

/**
 * Approve a tool for execution.
 * The source hash ensures the approval is tied to the exact source code.
 */
export async function approveTool(
  toolName: string,
  sourceHash: string,
  permissions: string[] = [],
): Promise<void> {
  const approvals = await loadApprovals();
  approvals[toolName] = {
    toolName,
    sourceHash,
    approved: true,
    approvedAt: new Date().toISOString(),
    permissions,
  };
  await saveApprovals(approvals);
}

/**
 * Revoke approval for a tool.
 */
export async function revokeToolApproval(toolName: string): Promise<void> {
  const approvals = await loadApprovals();
  delete approvals[toolName];
  await saveApprovals(approvals);
}

/**
 * List all approved tools.
 */
export async function listApprovedTools(): Promise<ToolApproval[]> {
  const approvals = await loadApprovals();
  return Object.values(approvals).filter((a) => a.approved);
}

// ─── Hot-Reloading (Leak-Free) ───────────────────────────────────────

/**
 * Worker pool for tool execution.
 * Workers are recycled rather than using cache-busting ESM query strings.
 */
class ToolWorkerPool {
  private workers: Map<string, Worker> = new Map();

  /**
   * Get or create a worker for a compiled tool.
   * If the tool was already loaded, terminate the old worker and create a new one.
   */
  async getWorker(compiledPath: string): Promise<Worker> {
    // Terminate existing worker for this path (leak-free reload)
    const existing = this.workers.get(compiledPath);
    if (existing) {
      await existing.terminate();
      this.workers.delete(compiledPath);
    }

    // Create a new worker
    const worker = new Worker(compiledPath, {
      workerData: null,
    });

    this.workers.set(compiledPath, worker);
    return worker;
  }

  /**
   * Terminate all workers.
   */
  async terminateAll(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.terminate();
    }
    this.workers.clear();
  }

  /**
   * Get the number of active workers.
   */
  get size(): number {
    return this.workers.size;
  }
}

export const toolWorkerPool = new ToolWorkerPool();

// ─── Tool Metadata ───────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of source code.
 */
export function hashSource(sourceCode: string): string {
  return crypto.createHash("sha256").update(sourceCode).digest("hex");
}

/**
 * Save tool metadata.
 */
export async function saveToolMetadata(metadata: ToolMetadata): Promise<void> {
  const metaPath = path.join(getProjectToolsDir(), `${metadata.name}.meta.json`);
  await fs.mkdir(path.dirname(metaPath), { recursive: true });
  await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2), "utf8");
}

/**
 * Load tool metadata.
 */
export async function loadToolMetadata(toolName: string): Promise<ToolMetadata | null> {
  try {
    const metaPath = path.join(getProjectToolsDir(), `${toolName}.meta.json`);
    const content = await fs.readFile(metaPath, "utf8");
    return JSON.parse(content) as ToolMetadata;
  } catch {
    return null;
  }
}

/**
 * List all generated tools with their metadata.
 */
export async function listGeneratedTools(): Promise<ToolMetadata[]> {
  const toolsDir = getProjectToolsDir();
  try {
    const files = await fs.readdir(toolsDir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    const results: ToolMetadata[] = [];

    for (const file of metaFiles) {
      try {
        const content = await fs.readFile(path.join(toolsDir, file), "utf8");
        results.push(JSON.parse(content) as ToolMetadata);
      } catch {
        // Skip corrupt metadata
      }
    }

    return results;
  } catch {
    return [];
  }
}