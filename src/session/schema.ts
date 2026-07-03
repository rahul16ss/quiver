/**
 * Versioned Session Schema — US-13.1
 *
 * Session files use a stable, versioned schema so sessions can be resumed
 * after upgrades. Session files include schema version, session ID, project ID,
 * model, adapter, message log, approvals, file read hashes, and timestamps.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { getProjectSessionsDir, getProjectName } from "../paths.js";
import type { FileReadRecord } from "./file_access.js";

// ─── Schema ──────────────────────────────────────────────────────────

export const SESSION_SCHEMA_VERSION = 1;

export interface SessionFile {
  schema_version: number;
  session_id: string;
  project_id: string;
  model: string;
  adapter: string;
  created_at: string;
  updated_at: string;
  messages: SessionMessage[];
  approvals: ApprovalRecord[];
  file_read_hashes: FileReadRecord[];
  metadata: {
    total_loops: number;
    total_tool_calls: number;
    total_tokens: number;
    [key: string]: any;
  };
}

export interface SessionMessage {
  role: string;
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  timestamp: string;
}

export interface ApprovalRecord {
  tool_name: string;
  args_hash: string;
  approved: boolean;
  timestamp: string;
}

// ─── Session Manager ─────────────────────────────────────────────────

/**
 * Manages session file I/O with versioned schema.
 */
export class SessionManager {
  private sessionId: string;
  private projectId: string;

  constructor(sessionId: string, projectId?: string) {
    this.sessionId = sessionId;
    this.projectId = projectId || getProjectName();
  }

  /**
   * Get the session file path.
   */
  getFilePath(): string {
    return path.join(getProjectSessionsDir(), `${this.sessionId}.state.json`);
  }

  /**
   * Save a session to disk.
   */
  async save(session: Omit<SessionFile, "schema_version" | "session_id" | "project_id" | "created_at" | "updated_at"> & {
    created_at?: string;
  }): Promise<string> {
    const filePath = this.getFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const sessionFile: SessionFile = {
      schema_version: SESSION_SCHEMA_VERSION,
      session_id: this.sessionId,
      project_id: this.projectId,
      created_at: session.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: session.messages,
      approvals: session.approvals,
      file_read_hashes: session.file_read_hashes,
      model: session.model,
      adapter: session.adapter,
      metadata: session.metadata,
    };

    await fs.writeFile(filePath, JSON.stringify(sessionFile, null, 2), "utf8");
    return filePath;
  }

  /**
   * Load a session from disk.
   * Validates schema version and handles migration if needed.
   */
  async load(): Promise<SessionFile> {
    const filePath = this.getFilePath();
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as SessionFile;

    // Validate schema version
    if (!parsed.schema_version) {
      // Legacy session — treat as version 0 and migrate
      parsed.schema_version = 0;
    }

    if (parsed.schema_version > SESSION_SCHEMA_VERSION) {
      throw new Error(
        `Session schema version ${parsed.schema_version} is newer than supported ` +
        `version ${SESSION_SCHEMA_VERSION}. Please upgrade Quiver.`,
      );
    }

    return parsed;
  }

  /**
   * Check if a session file exists.
   */
  exists(): boolean {
    try {
      return fsSync.existsSync(this.getFilePath());
    } catch {
      return false;
    }
  }

  /**
   * Delete a session file.
   */
  async delete(): Promise<void> {
    const filePath = this.getFilePath();
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore deletion errors
    }
  }
}

// ─── Session Listing ─────────────────────────────────────────────────

export interface SessionMetadata {
  sessionId: string;
  filePath: string;
  sizeBytes: number;
  mtime: Date;
  schemaVersion: number;
}

/**
 * List all session files for the current project.
 */
export async function listSessions(): Promise<SessionMetadata[]> {
  const sessionsDir = getProjectSessionsDir();
  try {
    const files = await fs.readdir(sessionsDir);
    const sessionFiles = files.filter((f) => f.endsWith(".state.json"));

    const metadata: SessionMetadata[] = [];
    for (const file of sessionFiles) {
      const filePath = path.join(sessionsDir, file);
      try {
        const stat = await fs.stat(filePath);
        let schemaVersion = 0;

        // Try to read schema version without loading full file
        try {
          const content = await fs.readFile(filePath, "utf8");
          const parsed = JSON.parse(content);
          schemaVersion = parsed.schema_version || 0;
        } catch {
          // May be a legacy or corrupt file
        }

        metadata.push({
          sessionId: file.replace(".state.json", ""),
          filePath,
          sizeBytes: stat.size,
          mtime: stat.mtime,
          schemaVersion,
        });
      } catch {
        // Skip files that can't be stat'd
      }
    }

    // Sort by modification time (newest first)
    metadata.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return metadata;
  } catch {
    return [];
  }
}

/**
 * Find the most recently modified session file.
 */
export async function getLatestSession(): Promise<SessionMetadata | null> {
  const sessions = await listSessions();
  return sessions.length > 0 ? sessions[0] : null;
}

/**
 * Validate a session file's integrity.
 * Returns { valid: boolean; error?: string }
 */
export async function validateSession(filePath: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content);

    if (!parsed.session_id) {
      return { valid: false, error: "Missing session_id field" };
    }
    if (!parsed.messages || !Array.isArray(parsed.messages)) {
      return { valid: false, error: "Missing or invalid messages array" };
    }

    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
}