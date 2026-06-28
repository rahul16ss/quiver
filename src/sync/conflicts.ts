/**
 * Sync Conflict Resolution — US-4.4
 *
 * When sync conflicts occur (both local and cloud versions changed),
 * both versions are preserved and a conflict resolution prompt is surfaced.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface ConflictRecord {
  file: string;
  localPath: string;
  cloudPath: string;
  localHash: string;
  cloudHash: string;
  localMtime: number;
  cloudMtime: number;
  detectedAt: string;
}

export type ConflictResolution = "keep_local" | "keep_cloud" | "keep_both" | "skip";

export interface ConflictResolutionResult {
  file: string;
  resolution: ConflictResolution;
  success: boolean;
  message: string;
}

// ─── Conflict Detection ──────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file.
 */
async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Detect sync conflicts between local and cloud versions of a file.
 * A conflict exists when both versions have changed (different hashes).
 *
 * @param localPath - Local file path
 * @param cloudPath - Cloud file path
 * @returns Conflict record if conflict detected, null otherwise
 */
export async function detectConflict(
  localPath: string,
  cloudPath: string,
): Promise<ConflictRecord | null> {
  if (!fsSync.existsSync(localPath) || !fsSync.existsSync(cloudPath)) {
    return null;
  }

  const localHash = await hashFile(localPath);
  const cloudHash = await hashFile(cloudPath);

  if (localHash === cloudHash) {
    return null; // No conflict — files are identical
  }

  const localStat = await fs.stat(localPath);
  const cloudStat = await fs.stat(cloudPath);

  return {
    file: path.basename(localPath),
    localPath,
    cloudPath,
    localHash,
    cloudHash,
    localMtime: localStat.mtimeMs,
    cloudMtime: cloudStat.mtimeMs,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Resolve a sync conflict based on the chosen resolution.
 *
 * @param conflict - The conflict record
 * @param resolution - The chosen resolution
 * @returns Resolution result
 */
export async function resolveConflict(
  conflict: ConflictRecord,
  resolution: ConflictResolution,
): Promise<ConflictResolutionResult> {
  try {
    switch (resolution) {
      case "keep_local": {
        // Overwrite cloud with local
        await fs.copyFile(conflict.localPath, conflict.cloudPath);
        return {
          file: conflict.file,
          resolution,
          success: true,
          message: "Kept local version, overwrote cloud copy.",
        };
      }

      case "keep_cloud": {
        // Overwrite local with cloud
        await fs.copyFile(conflict.cloudPath, conflict.localPath);
        return {
          file: conflict.file,
          resolution,
          success: true,
          message: "Kept cloud version, overwrote local copy.",
        };
      }

      case "keep_both": {
        // Rename cloud version with .cloud suffix
        const cloudDir = path.dirname(conflict.cloudPath);
        const cloudBasename = path.basename(conflict.cloudPath);
        const conflictPath = path.join(cloudDir, `${cloudBasename}.cloud.${Date.now()}`);
        await fs.copyFile(conflict.cloudPath, conflictPath);
        return {
          file: conflict.file,
          resolution,
          success: true,
          message: `Both versions preserved. Cloud version saved as ${path.basename(conflictPath)}.`,
        };
      }

      case "skip": {
        return {
          file: conflict.file,
          resolution,
          success: true,
          message: "Skipped — no changes made. Conflict will be detected again on next sync.",
        };
      }

      default:
        return {
          file: conflict.file,
          resolution,
          success: false,
          message: `Unknown resolution: ${resolution}`,
        };
    }
  } catch (error: any) {
    return {
      file: conflict.file,
      resolution,
      success: false,
      message: error.message,
    };
  }
}

/**
 * Format a conflict for CLI display.
 */
export function formatConflictForCLI(conflict: ConflictRecord): string {
  const lines: string[] = [
    `Sync conflict detected: ${conflict.file}`,
    `  Local:  modified ${new Date(conflict.localMtime).toISOString()}`,
    `  Cloud:  modified ${new Date(conflict.cloudMtime).toISOString()}`,
    "",
    "Resolution options:",
    "  1. Keep local (overwrite cloud)",
    "  2. Keep cloud (overwrite local)",
    "  3. Keep both (rename cloud version)",
    "  4. Skip (resolve later)",
  ];
  return lines.join("\n");
}

/**
 * Scan a directory pair for conflicts.
 */
export async function scanForConflicts(
  localDir: string,
  cloudDir: string,
): Promise<ConflictRecord[]> {
  const conflicts: ConflictRecord[] = [];

  if (!fsSync.existsSync(localDir) || !fsSync.existsSync(cloudDir)) {
    return conflicts;
  }

  const localFiles = await fs.readdir(localDir);
  const cloudFiles = await fs.readdir(cloudDir);

  const allFiles = new Set([...localFiles, ...cloudFiles]);

  for (const file of allFiles) {
    const localPath = path.join(localDir, file);
    const cloudPath = path.join(cloudDir, file);

    const conflict = await detectConflict(localPath, cloudPath);
    if (conflict) {
      conflicts.push(conflict);
    }
  }

  return conflicts;
}