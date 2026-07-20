/**
 * Scratch-area semantics — US-17.14 / Build Order #4.
 *
 * When the active trust tier is "build" (buyer-facing: "Draft & research"),
 * all file writes are redirected to a scratch staging area inside the
 * workspace (`.quiver/scratch/`). The user reviews the drafts and promotes
 * them to the real workspace path with the `/promote` command.
 *
 * This makes the "Draft & research" tier true to its name: the agent drafts
 * and researches, but never touches the firm's real files until a human
 * promotes.
 *
 * Architecture:
 *   - `resolveScratchPath(filePath)` — maps a real workspace path to its
 *     scratch equivalent. Returns null when scratch mode is inactive.
 *   - `isScratchModeActive()` — checks whether the current trust tier
 *     requires scratch-area redirection.
 *   - `promoteFile(scratchPath, workspaceRoot)` — moves a file from scratch
 *     to its real workspace location, creating parent directories.
 *   - `listScratchFiles(workspaceRoot)` — lists all files in the scratch
 *     area with their real-path targets.
 *   - `clearScratch(workspaceRoot)` — removes the scratch directory.
 */

import * as path from "path";
import * as fs from "fs";
import { config, TrustTier } from "../config.js";

/** The scratch directory name, relative to the workspace root. */
export const SCRATCH_DIR_NAME = ".quiver/scratch";

/** Trust tiers that require scratch-area redirection for writes. */
const SCRATCH_TIERS: TrustTier[] = ["build"];

/**
 * Check whether the current trust tier requires scratch-area semantics.
 * When true, all write operations are redirected to .quiver/scratch/.
 */
export function isScratchModeActive(): boolean {
  const tier = config.trustTier;
  if (!tier) return false;
  return SCRATCH_TIERS.includes(tier);
}

/**
 * Get the scratch directory path for a given workspace root.
 */
export function getScratchDir(workspaceRoot: string = process.cwd()): string {
  return path.join(workspaceRoot, SCRATCH_DIR_NAME);
}

/**
 * Map a real workspace file path to its scratch-area equivalent.
 *
 * Example:
 *   workspaceRoot = /Users/rahul/quiver
 *   filePath     = /Users/rahul/quiver/src/cli.ts
 *   → /Users/rahul/quiver/.quiver/scratch/src/cli.ts
 *
 * Returns null if:
 *   - Scratch mode is not active
 *   - The file is outside the workspace
 *   - The file is already inside the scratch directory
 */
export function resolveScratchPath(
  filePath: string,
  workspaceRoot: string = process.cwd(),
): string | null {
  if (!isScratchModeActive()) return null;

  const absRoot = path.resolve(workspaceRoot);
  const absFile = path.resolve(filePath);

  // If the file is already inside the scratch directory, no redirection needed
  const scratchDir = getScratchDir(absRoot);
  if (absFile.startsWith(scratchDir + path.sep) || absFile === scratchDir) {
    return null;
  }

  // If the file is outside the workspace, no redirection (path policy will block it)
  const rel = path.relative(absRoot, absFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }

  // Redirect to scratch
  return path.join(scratchDir, rel);
}

/**
 * Reverse mapping: given a scratch path, return the real workspace path.
 *
 * Example:
 *   scratchPath  = /Users/rahul/quiver/.quiver/scratch/src/cli.ts
 *   workspaceRoot = /Users/rahul/quiver
 *   → /Users/rahul/quiver/src/cli.ts
 *
 * Returns null if the path is not inside the scratch directory.
 */
export function resolveRealPath(
  scratchPath: string,
  workspaceRoot: string = process.cwd(),
): string | null {
  const absRoot = path.resolve(workspaceRoot);
  const scratchDir = getScratchDir(absRoot);
  const absScratch = path.resolve(scratchPath);

  if (!absScratch.startsWith(scratchDir + path.sep)) {
    return null;
  }

  const rel = path.relative(scratchDir, absScratch);
  return path.join(absRoot, rel);
}

/**
 * Ensure the scratch directory exists for the given workspace.
 */
export function ensureScratchDir(
  workspaceRoot: string = process.cwd(),
): string {
  const scratchDir = getScratchDir(workspaceRoot);
  fs.mkdirSync(scratchDir, { recursive: true });
  return scratchDir;
}

/**
 * Promote a single file from the scratch area to its real workspace location.
 *
 * - Creates parent directories as needed.
 * - Overwrites the real file if it already exists.
 * - Removes the scratch copy after successful copy.
 * - Returns the real path on success.
 */
export function promoteFile(
  scratchPath: string,
  workspaceRoot: string = process.cwd(),
): string {
  const realPath = resolveRealPath(scratchPath, workspaceRoot);
  if (!realPath) {
    throw new Error(
      `Path '${scratchPath}' is not inside the scratch directory. ` +
        `Expected it to be under '${getScratchDir(workspaceRoot)}'.`,
    );
  }

  if (!fs.existsSync(scratchPath)) {
    throw new Error(`Scratch file not found: ${scratchPath}`);
  }

  // Create parent directories for the real path
  const parentDir = path.dirname(realPath);
  fs.mkdirSync(parentDir, { recursive: true });

  // Copy scratch → real, then remove scratch
  fs.copyFileSync(scratchPath, realPath);
  fs.unlinkSync(scratchPath);

  // Clean up empty parent directories in scratch
  cleanEmptyScratchDirs(scratchPath, workspaceRoot);

  return realPath;
}

/**
 * Promote all files from the scratch area to their real workspace locations.
 *
 * Returns a list of promoted files with { scratch, real } pairs.
 */
export function promoteAll(
  workspaceRoot: string = process.cwd(),
): Array<{ scratch: string; real: string }> {
  const scratchDir = getScratchDir(workspaceRoot);
  const results: Array<{ scratch: string; real: string }> = [];

  if (!fs.existsSync(scratchDir)) {
    return results;
  }

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const real = resolveRealPath(fullPath, workspaceRoot);
        if (real) {
          fs.mkdirSync(path.dirname(real), { recursive: true });
          fs.copyFileSync(fullPath, real);
          fs.unlinkSync(fullPath);
          results.push({ scratch: fullPath, real });
        }
      }
    }
  };

  walk(scratchDir);

  // Clean up empty directories
  cleanEmptyScratchDirs(scratchDir, workspaceRoot);

  return results;
}

/**
 * List all files in the scratch area with their real-path targets.
 */
export function listScratchFiles(
  workspaceRoot: string = process.cwd(),
): Array<{ scratch: string; real: string; relative: string }> {
  const scratchDir = getScratchDir(workspaceRoot);
  const results: Array<{ scratch: string; real: string; relative: string }> =
    [];

  if (!fs.existsSync(scratchDir)) {
    return results;
  }

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const real = resolveRealPath(fullPath, workspaceRoot);
        if (real) {
          results.push({
            scratch: fullPath,
            real,
            relative: path.relative(workspaceRoot, real),
          });
        }
      }
    }
  };

  walk(scratchDir);
  return results;
}

/**
 * Remove the entire scratch directory.
 */
export function clearScratch(workspaceRoot: string = process.cwd()): void {
  const scratchDir = getScratchDir(workspaceRoot);
  if (fs.existsSync(scratchDir)) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Remove empty parent directories in the scratch area after a file is promoted.
 */
function cleanEmptyScratchDirs(filePath: string, workspaceRoot: string): void {
  const scratchDir = getScratchDir(workspaceRoot);
  let dir = path.dirname(filePath);

  while (dir.startsWith(scratchDir) && dir !== scratchDir) {
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length === 0) {
        fs.rmdirSync(dir);
      } else {
        break;
      }
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}
