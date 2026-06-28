/**
 * Hash-Based Read-Before-Write Verification — US-6.1 / US-10.1
 *
 * Reading a file stores its canonical path, modification time (mtimeMs),
 * size, and content SHA-256 hash.
 * Writing requires a match on the content hash and mtimeMs (compare-and-swap).
 * Mismatch rejects the write and prompts the model to re-read.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface FileReadRecord {
  realPath: string;
  sha256: string;
  mtimeMs: number;
  sizeBytes: number;
  readAt: string;
  sessionId: string;
}

export class WriteBlockedException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteBlockedException";
  }
}

// ─── File Read History ───────────────────────────────────────────────

/**
 * Session-bound FileReadHistory database.
 * Tracks all files read in the current session with their hashes.
 */
export class FileReadHistory {
  private records: Map<string, FileReadRecord> = new Map();
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Record that a file was read. Stores path, hash, mtime, and size.
   */
  async recordRead(filePath: string): Promise<FileReadRecord> {
    const resolvedPath = path.resolve(filePath);

    // Get file stats
    const stat = await fs.stat(resolvedPath);
    const content = await fs.readFile(resolvedPath);

    const hash = crypto.createHash("sha256").update(content).digest("hex");

    const record: FileReadRecord = {
      realPath: resolvedPath,
      sha256: hash,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      readAt: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    this.records.set(resolvedPath, record);
    return record;
  }

  /**
   * Check if a file was read in this session.
   */
  wasRead(filePath: string): boolean {
    return this.records.has(path.resolve(filePath));
  }

  /**
   * Get the read record for a file.
   */
  getRecord(filePath: string): FileReadRecord | undefined {
    return this.records.get(path.resolve(filePath));
  }

  /**
   * Verify that a file's current state matches its read record.
   * Used as compare-and-swap before writing.
   *
   * @returns { matches: boolean; reason?: string }
   */
  async verifyBeforeWrite(filePath: string): Promise<{ matches: boolean; reason?: string }> {
    const resolvedPath = path.resolve(filePath);
    const record = this.records.get(resolvedPath);

    if (!record) {
      // File was never read — check if it exists
      if (fsSync.existsSync(resolvedPath)) {
        return {
          matches: false,
          reason: `File '${filePath}' exists but was never read in this session. Use view_file to read it first.`,
        };
      }
      // New file creation — no read required
      return { matches: true };
    }

    // File was read — verify hash and mtime
    if (!fsSync.existsSync(resolvedPath)) {
      return {
        matches: false,
        reason: `File '${filePath}' was read but no longer exists. It may have been deleted.`,
      };
    }

    const stat = await fs.stat(resolvedPath);
    const content = await fs.readFile(resolvedPath);
    const currentHash = crypto.createHash("sha256").update(content).digest("hex");

    if (currentHash !== record.sha256) {
      return {
        matches: false,
        reason: `File '${filePath}' has been modified since it was last read (hash mismatch). ` +
          `Re-read the file before writing to avoid overwriting changes.`,
      };
    }

    if (Math.abs(stat.mtimeMs - record.mtimeMs) > 100) {
      return {
        matches: false,
        reason: `File '${filePath}' modification time has changed since it was last read. ` +
          `Re-read the file before writing.`,
      };
    }

    return { matches: true };
  }

  /**
   * Assert that a file can be written (throws WriteBlockedException if not).
   */
  async assertCanWrite(filePath: string): Promise<void> {
    const { matches, reason } = await this.verifyBeforeWrite(filePath);
    if (!matches) {
      throw new WriteBlockedException(reason || "Write blocked: file verification failed.");
    }
  }

  /**
   * Get all read records (for session serialization).
   */
  getAllRecords(): FileReadRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Hydrate read history from saved records (for session resume).
   */
  hydrateFromRecords(records: FileReadRecord[]): void {
    for (const record of records) {
      this.records.set(record.realPath, record);
    }
  }

  /**
   * Clear all records.
   */
  clear(): void {
    this.records.clear();
  }

  /**
   * Get the number of files read.
   */
  get size(): number {
    return this.records.size;
  }
}

// ─── Helper: Quick Hash ──────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a file's content.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA-256 hash of a string.
 */
export function hashString(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}