/**
 * Subagent Sandbox — US-5.3
 *
 * Subagents run on copy-on-write scratchpads in isolated session directories.
 * They cannot write directly to workspace files.
 * Changes are merged back into the main project only after validation.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { DEFAULT_SUBAGENT_CONFIG, type SubagentConfig } from "./types.js";

// ─── Scratchpad Management ───────────────────────────────────────────

async function copyDirectory(src: string, dest: string, excludeDirs: string[]): Promise<void> {
  try {
    const entries = await fs.readdir(src, { withFileTypes: true });
    await fs.mkdir(dest, { recursive: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) {
          continue;
        }
        await copyDirectory(srcPath, destPath, excludeDirs);
      } else if (entry.isFile()) {
        try {
          await fs.copyFile(srcPath, destPath);
        } catch {}
      }
    }
  } catch {}
}

/**
 * Create an isolated scratchpad directory for a subagent.
 * Files are copied on-write — the subagent gets its own working copy.
 */
export async function createScratchpad(
  taskId: string,
  workspaceRoot: string,
  config: SubagentConfig = DEFAULT_SUBAGENT_CONFIG,
): Promise<string> {
  const scratchpad = path.join(workspaceRoot, config.scratchpadDir, taskId);
  await fs.mkdir(scratchpad, { recursive: true });
  
  const exclude = [
    ".git",
    "node_modules",
    ".sessions",
    ".quiver-backups",
    config.scratchpadDir,
  ];
  await copyDirectory(workspaceRoot, scratchpad, exclude);
  return scratchpad;
}

/**
 * Clean up a scratchpad after the subagent completes.
 */
export async function cleanupScratchpad(
  taskId: string,
  workspaceRoot: string,
  config: SubagentConfig = DEFAULT_SUBAGENT_CONFIG,
): Promise<void> {
  const scratchpad = path.join(workspaceRoot, config.scratchpadDir, taskId);
  try {
    await fs.rm(scratchpad, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Validate subagent results before merging.
 * Checks that modified files are within the workspace and not blocked.
 *
 * @param filesModified - List of file paths the subagent modified
 * @param workspaceRoot - The main workspace root
 * @param blockedPaths - Glob patterns for blocked paths
 * @param scratchpadDir - Optional scratchpad directory to resolve real file paths (prevents symlink escapes)
 * @returns { valid: string[]; invalid: string[] }
 */
export function validateSubagentFiles(
  filesModified: string[],
  workspaceRoot: string,
  blockedPaths: string[] = [],
  scratchpadDir?: string,
): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];

  const defaultBlocked = [".env", ".env.*", "*.pem", "*.key", ".git/", "node_modules/"];
  const allBlocked = [...defaultBlocked, ...blockedPaths];

  // Make sure workspaceRoot is resolved
  let resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  try {
    resolvedWorkspaceRoot = fsSync.realpathSync(resolvedWorkspaceRoot);
  } catch {
    // ignore
  }

  for (const file of filesModified) {
    let resolved = path.isAbsolute(file)
      ? file
      : scratchpadDir
      ? path.join(scratchpadDir, file)
      : path.join(resolvedWorkspaceRoot, file);

    try {
      resolved = fsSync.realpathSync(resolved);
    } catch {
      // File may not exist yet or is a dangling link
    }

    const relative = path.relative(resolvedWorkspaceRoot, resolved);

    // Check if inside workspace
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      invalid.push(file);
      continue;
    }

    // Check blocked patterns
    const basename = path.basename(resolved);
    const isBlocked = allBlocked.some((pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp(pattern.replace(/\./g, "\\.").replace(/\*/g, ".*"));
        return regex.test(basename) || regex.test(relative);
      }
      return relative.includes(pattern) || basename === pattern;
    });

    if (isBlocked) {
      invalid.push(file);
    } else {
      valid.push(file);
    }
  }

  return { valid, invalid };
}

/**
 * Merge validated subagent results back into the main workspace.
 * Copies files from the scratchpad to the workspace.
 */
export async function mergeSubagentResults(
  taskId: string,
  validFiles: string[],
  workspaceRoot: string,
  config: SubagentConfig = DEFAULT_SUBAGENT_CONFIG,
): Promise<{ merged: string[]; errors: string[] }> {
  const merged: string[] = [];
  const errors: string[] = [];
  const scratchpad = path.join(workspaceRoot, config.scratchpadDir, taskId);

  for (const file of validFiles) {
    try {
      const resolved = path.resolve(file);
      const relative = path.relative(workspaceRoot, resolved);
      const source = path.join(scratchpad, relative);
      const dest = resolved;

      // Ensure destination directory exists
      await fs.mkdir(path.dirname(dest), { recursive: true });

      // Copy from scratchpad to workspace
      await fs.copyFile(source, dest);
      merged.push(file);
    } catch (error: any) {
      errors.push(`Failed to merge ${file}: ${error.message}`);
    }
  }

  return { merged, errors };
}