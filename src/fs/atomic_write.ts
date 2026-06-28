/**
 * Atomic Writes with Rollback — US-10.2
 *
 * Writes are written to a temporary file first before replacement.
 * Backup of the existing file is created before overwrite.
 * Session log records backup paths.
 * Exposes /rollback last to restore backups.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ─── Backup History ──────────────────────────────────────────────────

interface BackupRecord {
  originalPath: string;
  backupPath: string;
  timestamp: string;
  wasNewFile: boolean;
}

/**
 * Session-scoped backup history.
 * Tracks all file writes for rollback capability.
 */
export class BackupHistory {
  private records: BackupRecord[] = [];

  /**
   * Record a backup.
   */
  record(originalPath: string, backupPath: string, wasNewFile: boolean): void {
    this.records.push({
      originalPath,
      backupPath,
      timestamp: new Date().toISOString(),
      wasNewFile,
    });
  }

  /**
   * Get the last backup record (for /rollback last).
   */
  getLastBackup(): BackupRecord | null {
    if (this.records.length === 0) return null;
    return this.records[this.records.length - 1];
  }

  /**
   * Get all backup records.
   */
  getAllBackups(): BackupRecord[] {
    return [...this.records];
  }

  /**
   * Get backups for a specific file path.
   */
  getBackupsForFile(filePath: string): BackupRecord[] {
    return this.records.filter((r) => r.originalPath === filePath);
  }

  /**
   * Clear history (after session save).
   */
  clear(): void {
    this.records = [];
  }
}

// Global session backup history
export const sessionBackups = new BackupHistory();

// ─── Atomic Write ────────────────────────────────────────────────────

/**
 * Perform an atomic write:
 * 1. If file exists, create a backup copy
 * 2. Write content to a temp file
 * 3. Rename temp file to target (atomic on most filesystems)
 *
 * @param filePath - The target file path
 * @param content - The content to write
 * @returns The backup path if a backup was created, null if file was new
 */
export async function atomicWrite(
  filePath: string,
  content: string,
): Promise<string | null> {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  let backupPath: string | null = null;
  const fileExists = fsSync.existsSync(resolvedPath);

  // Create backup if file exists
  if (fileExists) {
    const backupDir = path.join(dir, ".quiver-backups");
    await fs.mkdir(backupDir, { recursive: true });
    const basename = path.basename(resolvedPath);
    const hash = crypto.randomBytes(4).toString("hex");
    backupPath = path.join(backupDir, `${basename}.${hash}.bak`);
    await fs.copyFile(resolvedPath, backupPath);
  }

  // Write to temp file
  const tempPath = `${resolvedPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tempPath, content, "utf8");

    // Atomic rename
    await fs.rename(tempPath, resolvedPath);
  } catch (error) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }

  // Record in history
  sessionBackups.record(resolvedPath, backupPath || "", !fileExists);

  return backupPath;
}

/**
 * Rollback a write by restoring from backup.
 *
 * @param backupPath - The backup file path
 * @param originalPath - The original file path to restore
 */
export async function rollbackWrite(
  backupPath: string,
  originalPath: string,
): Promise<void> {
  if (!backupPath) {
    // File was newly created — delete it
    try {
      await fs.unlink(originalPath);
    } catch {
      // File may already be gone
    }
    return;
  }

  if (!fsSync.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  // Restore from backup
  await fs.copyFile(backupPath, originalPath);

  // Optionally clean up backup
  try {
    await fs.unlink(backupPath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Rollback the last write operation.
 */
export async function rollbackLast(): Promise<{ restored: string; wasNewFile: boolean } | null> {
  const last = sessionBackups.getLastBackup();
  if (!last) return null;

  await rollbackWrite(last.backupPath, last.originalPath);
  return { restored: last.originalPath, wasNewFile: last.wasNewFile };
}

/**
 * Get the backup directory path for a given file.
 */
export function getBackupDir(filePath: string): string {
  return path.join(path.dirname(path.resolve(filePath)), ".quiver-backups");
}