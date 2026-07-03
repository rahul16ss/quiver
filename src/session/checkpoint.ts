/**
 * Session Checkpoint & Crash Recovery — US-13.2
 *
 * Checkpoints are written to session logs after every turn and action.
 * On launch, Quiver detects incomplete/crashed sessions, prompting user
 * to resume, archive, or discard.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getProjectSessionsDir } from "../paths.js";
import { SessionManager, type SessionFile, type SessionMessage, type ApprovalRecord } from "./schema.js";
import type { FileReadRecord } from "./file_access.js";

// ─── Checkpoint Manager ──────────────────────────────────────────────

export class CheckpointManager {
  private sessionId: string;
  private projectId: string;
  private checkpointDir: string;
  private lastCheckpointPath: string | null = null;

  constructor(sessionId: string, projectId: string) {
    this.sessionId = sessionId;
    this.projectId = projectId;
    this.checkpointDir = path.join(getProjectSessionsDir(), "checkpoints");
  }

  /**
   * Write a checkpoint with the current session state.
   * Called after every turn and action.
   */
  async checkpoint(state: {
    messages: SessionMessage[];
    approvals: ApprovalRecord[];
    fileReadHashes: FileReadRecord[];
    model: string;
    adapter: string;
    auditHash?: string;
    metadata: {
      total_loops: number;
      total_tool_calls: number;
      total_tokens: number;
      audit_chain_hash?: string;
      [key: string]: any;
    };
  }): Promise<string> {
    await fs.mkdir(this.checkpointDir, { recursive: true });

    const timestamp = Date.now();
    const checkpointPath = path.join(
      this.checkpointDir,
      `${this.sessionId}_checkpoint_${timestamp}.json`,
    );

    // Compute checkpoint hash for tamper-evidence (US-9.5)
    // H_n = SHA-256(H_{n-1} + action_payload)
    const actionPayload = JSON.stringify({
      messages: state.messages.length,
      approvals: state.approvals.length,
      model: state.model,
      adapter: state.adapter,
      timestamp,
    });
    const prevHash = state.auditHash || "0".repeat(64);
    const chainHash = crypto
      .createHash("sha256")
      .update(prevHash + actionPayload)
      .digest("hex");

    const checkpoint: SessionFile = {
      schema_version: 1,
      session_id: this.sessionId,
      project_id: this.projectId,
      model: state.model,
      adapter: state.adapter,
      created_at: new Date(timestamp).toISOString(),
      updated_at: new Date(timestamp).toISOString(),
      messages: state.messages,
      approvals: state.approvals,
      file_read_hashes: state.fileReadHashes,
      metadata: {
        ...state.metadata,
        audit_chain_hash: chainHash,
      },
    };

    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");

    // Clean up old checkpoints (keep last 5)
    await this.pruneCheckpoints(5);

    this.lastCheckpointPath = checkpointPath;
    return checkpointPath;
  }

  /**
   * Get the latest audit chain hash.
   */
  getLatestAuditHash(): string | null {
    // This would read from the last checkpoint in a full implementation
    return null;
  }

  /**
   * Verify the audit chain integrity of all checkpoints for this session.
   * Returns true if all hashes are consistent.
   */
  async verifyAuditChain(): Promise<boolean> {
    try {
      const files = await fs.readdir(this.checkpointDir);
      const sessionCheckpoints = files
        .filter((f) => f.startsWith(`${this.sessionId}_checkpoint_`))
        .sort();

      let expectedPrevHash = "0".repeat(64);

      for (const file of sessionCheckpoints) {
        const filePath = path.join(this.checkpointDir, file);
        const content = await fs.readFile(filePath, "utf8");
        const checkpoint = JSON.parse(content) as SessionFile;
        const storedHash = checkpoint.metadata?.audit_chain_hash;

        if (!storedHash) continue;

        // Recompute hash
        const actionPayload = JSON.stringify({
          messages: checkpoint.messages.length,
          approvals: checkpoint.approvals.length,
          model: checkpoint.model,
          adapter: checkpoint.adapter,
          timestamp: new Date(checkpoint.updated_at).getTime(),
        });
        const computedHash = crypto
          .createHash("sha256")
          .update(expectedPrevHash + actionPayload)
          .digest("hex");

        if (storedHash !== computedHash) return false;
        expectedPrevHash = storedHash;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the latest checkpoint for this session.
   */
  async getLatestCheckpoint(): Promise<SessionFile | null> {
    try {
      const files = await fs.readdir(this.checkpointDir);
      const sessionCheckpoints = files
        .filter((f) => f.startsWith(`${this.sessionId}_checkpoint_`))
        .sort()
        .reverse();

      if (sessionCheckpoints.length === 0) return null;

      const latestPath = path.join(this.checkpointDir, sessionCheckpoints[0]);
      const content = await fs.readFile(latestPath, "utf8");
      return JSON.parse(content) as SessionFile;
    } catch {
      return null;
    }
  }

  /**
   * Remove old checkpoints, keeping only the most recent N.
   */
  async pruneCheckpoints(keepCount: number): Promise<void> {
    try {
      const files = await fs.readdir(this.checkpointDir);
      const sessionCheckpoints = files
        .filter((f) => f.startsWith(`${this.sessionId}_checkpoint_`))
        .sort()
        .reverse();

      const toDelete = sessionCheckpoints.slice(keepCount);
      for (const file of toDelete) {
        await fs.unlink(path.join(this.checkpointDir, file));
      }
    } catch {
      // Ignore pruning errors
    }
  }

  /**
   * Get the last checkpoint path.
   */
  getLastCheckpointPath(): string | null {
    return this.lastCheckpointPath;
  }
}

// ─── Crash Detection ─────────────────────────────────────────────────

export interface CrashDetectionResult {
  hasCrashedSession: boolean;
  sessionId: string | null;
  checkpointPath: string | null;
  sessionFile: SessionFile | null;
}

/**
 * Detect if there's an incomplete/crashed session from a previous run.
 * A session is considered crashed if:
 * 1. It has a checkpoint but no final session file, OR
 * 2. The session file exists but doesn't have a proper "session_end" marker
 */
export async function detectCrashedSession(projectId: string): Promise<CrashDetectionResult> {
  const checkpointDir = path.join(getProjectSessionsDir(), "checkpoints");

  try {
    // Check for checkpoint files
    if (!fsSync.existsSync(checkpointDir)) {
      return { hasCrashedSession: false, sessionId: null, checkpointPath: null, sessionFile: null };
    }

    const files = await fs.readdir(checkpointDir);
    if (files.length === 0) {
      return { hasCrashedSession: false, sessionId: null, checkpointPath: null, sessionFile: null };
    }

    // Find the most recent checkpoint
    const sorted = files.sort().reverse();
    const latestCheckpointFile = sorted[0];
    const checkpointPath = path.join(checkpointDir, latestCheckpointFile);

    try {
      const content = await fs.readFile(checkpointPath, "utf8");
      const sessionFile = JSON.parse(content) as SessionFile;

      // Check if the session has a corresponding final session file
      const sessionManager = new SessionManager(sessionFile.session_id, projectId);
      const hasSession = sessionFileExists(sessionFile.session_id);

      if (!hasSession) {
        // Session was never properly saved — likely crashed
        return {
          hasCrashedSession: true,
          sessionId: sessionFile.session_id,
          checkpointPath,
          sessionFile,
        };
      }

      // Session file exists — check if it's complete.
      // The session .json file may be in one of two formats:
      //   (a) A SessionFile object (with metadata.session_end) — written by
      //       SessionManager.save()
      //   (b) A JSON array of log events (each with type/data) — written by
      //       SessionLogger.flush().  This is the common case.
      // We handle both: for (a) check metadata.session_end; for (b) scan the
      // log entries for a "session_end" event.
      const finalContent = await fs.readFile(sessionManager.getFilePath(), "utf8");
      const parsed = JSON.parse(finalContent);

      let isComplete = false;
      if (Array.isArray(parsed)) {
        // Log-file format: look for a "session_end" event entry
        isComplete = parsed.some(
          (entry: any) =>
            entry?.type === "session_end" ||
            entry?.data?.type === "session_end",
        );
      } else if (parsed && typeof parsed === "object") {
        // SessionFile format: check metadata.session_end
        isComplete = !!parsed.metadata?.session_end;
      }

      if (!isComplete) {
        return {
          hasCrashedSession: true,
          sessionId: sessionFile.session_id,
          checkpointPath,
          sessionFile,
        };
      }

      return { hasCrashedSession: false, sessionId: null, checkpointPath: null, sessionFile: null };
    } catch {
      return { hasCrashedSession: false, sessionId: null, checkpointPath: null, sessionFile: null };
    }
  } catch {
    return { hasCrashedSession: false, sessionId: null, checkpointPath: null, sessionFile: null };
  }
}

/**
 * Check if a session file exists.
 */
function sessionFileExists(sessionId: string): boolean {
  const sessionPath = path.join(getProjectSessionsDir(), `${sessionId}.state.json`);
  return fsSync.existsSync(sessionPath);
}

/**
 * Archive a crashed session's checkpoints.
 */
export async function archiveCrashedSession(sessionId: string): Promise<void> {
  const checkpointDir = path.join(getProjectSessionsDir(), "checkpoints");
  const archiveDir = path.join(getProjectSessionsDir(), "archived");
  await fs.mkdir(archiveDir, { recursive: true });

  try {
    const files = await fs.readdir(checkpointDir);
    const sessionFiles = files.filter((f) => f.startsWith(`${sessionId}_checkpoint_`));

    for (const file of sessionFiles) {
      const src = path.join(checkpointDir, file);
      const dest = path.join(archiveDir, file);
      await fs.rename(src, dest);
    }
  } catch {
    // Ignore archive errors
  }
}

/**
 * Discard a crashed session's checkpoints.
 */
export async function discardCrashedSession(sessionId: string): Promise<void> {
  const checkpointDir = path.join(getProjectSessionsDir(), "checkpoints");

  try {
    const files = await fs.readdir(checkpointDir);
    const sessionFiles = files.filter((f) => f.startsWith(`${sessionId}_checkpoint_`));

    for (const file of sessionFiles) {
      await fs.unlink(path.join(checkpointDir, file));
    }
  } catch {
    // Ignore discard errors
  }
}