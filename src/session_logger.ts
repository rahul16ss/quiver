/**
 * SessionLogger — accumulates structured events in memory and flushes to disk.
 *
 * Extracted from agent.ts for modularity and testability.
 *
 * Design:
 *   - Events are accumulated in memory (no disk I/O per event)
 *   - flush() writes all accumulated logs as JSON
 *   - flushSync() for exit handlers (SIGINT/SIGTERM)
 *   - All log data is sanitized: secrets redacted, large text truncated
 *   - Logging never throws — failures are silently swallowed
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { config } from "./config.js";
import { getProjectSessionsDir, getProjectName } from "./paths.js";

import { redactSecrets } from "./security/secrets.js";

// ─── Truncation ──────────────────────────────────────────────────────

export function truncateForLog(
  text: string,
  maxChars: number,
): { text: string; length: number; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, length: text.length, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}…`,
    length: text.length,
    truncated: true,
  };
}

// ─── Secret Redaction ────────────────────────────────────────────────
// Redacts API keys, tokens, and other secrets from log/state output.
// Patterns cover common secret formats and .env KEY=VALUE lines.

/** Safe JSON.stringify that handles circular references without throwing. */
export function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj);
  } catch {
    try {
      return JSON.stringify(obj, (_key, value) => {
        if (typeof value === "object" && value !== null) {
          return "[object]";
        }
        return value;
      });
    } catch {
      return String(obj);
    }
  }
}

export function sanitizeLogData(type: string, data: any): any {
  const maxChars = config.sessionLogMaxChars;

  switch (type) {
    case "user_input": {
      const content = redactSecrets(String(data?.content ?? ""));
      const truncated = truncateForLog(content, maxChars);
      return {
        content: truncated.text,
        contentLength: truncated.length,
        truncated: truncated.truncated,
      };
    }
    case "assistant_response": {
      const content = redactSecrets(String(data?.content ?? ""));
      const truncated = truncateForLog(content, maxChars);
      const tool_calls = Array.isArray(data?.tool_calls)
        ? data.tool_calls.map((tc: any) => {
            const args = redactSecrets(String(tc?.function?.arguments ?? ""));
            const argsTruncated = truncateForLog(args, maxChars);
            return {
              id: tc?.id,
              type: tc?.type,
              function: {
                name: tc?.function?.name,
                arguments: argsTruncated.text,
                argumentsLength: argsTruncated.length,
                truncated: argsTruncated.truncated,
              },
            };
          })
        : undefined;
      return {
        role: data?.role,
        content: truncated.text,
        contentLength: truncated.length,
        truncated: truncated.truncated,
        tool_calls,
      };
    }
    case "tool_result": {
      const result = data?.result;
      const resultStr =
        typeof result === "string" ? result : safeStringify(result ?? "");
      const redacted = redactSecrets(resultStr);
      const truncated = truncateForLog(redacted, maxChars);
      return {
        tool: data?.tool,
        callId: data?.callId,
        result: truncated.text,
        resultLength: truncated.length,
        truncated: truncated.truncated,
      };
    }
    case "api_error": {
      const response = redactSecrets(String(data?.response ?? ""));
      const truncated = truncateForLog(response, maxChars);
      return {
        error: data?.error,
        status: data?.status,
        retries: data?.retries,
        response: truncated.text,
        responseLength: truncated.length,
        truncated: truncated.truncated,
      };
    }
    default:
      return data;
  }
}

// ─── SessionLogger ───────────────────────────────────────────────────

export class SessionLogger {
  private sessionId: string;
  private logPath: string;
  private logs: any[] = [];
  private dirEnsured = false;

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.logPath = path.join(getProjectSessionsDir(), `${this.sessionId}.json`);
  }

  /** Accumulate event in memory — no disk I/O until flush(). */
  public logEvent(type: string, data: any): void {
    if (!config.sessionLogEnabled) return;

    this.logs.push({
      timestamp: new Date().toISOString(),
      type,
      data: sanitizeLogData(type, data),
    });
  }

  /** Write accumulated logs to disk once. Call at session end or on error. */
  public async flush(): Promise<void> {
    if (this.logs.length === 0) return;
    try {
      if (!this.dirEnsured) {
        await fs.mkdir(path.dirname(this.logPath), { recursive: true });
        this.dirEnsured = true;
      }
      await fs.writeFile(
        this.logPath,
        JSON.stringify(this.logs, null, 2),
        "utf8",
      );
    } catch {
      // Fail silently — logging must never crash the agent
    }
  }

  /** Synchronous flush for use in exit handlers and SIGINT/SIGTERM contexts. */
  public flushSync(): void {
    if (this.logs.length === 0) return;
    try {
      fsSync.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fsSync.writeFileSync(
        this.logPath,
        JSON.stringify(this.logs, null, 2),
        "utf8",
      );
    } catch {
      // Fail silently — logging must never crash the agent
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionLogPath(): string {
    return this.logPath;
  }

  public getSessionLogRelPath(): string {
    return path.join(getProjectName(), ".sessions", `${this.sessionId}.json`);
  }

  /** Get the number of accumulated log entries (for testing). */
  public getLogCount(): number {
    return this.logs.length;
  }

  /** Get a copy of the accumulated logs (for testing). */
  public getLogs(): any[] {
    return [...this.logs];
  }
}

// ─── Log Retention & Management — US-13.3 ───────────────────────────

export interface LogMetadata {
  sessionId: string;
  filePath: string;
  sizeBytes: number;
  mtime: Date;
  eventCount: number;
}

/**
 * List all session log files for the current project.
 * Supports the /logs list CLI command.
 */
export async function listSessionLogs(): Promise<LogMetadata[]> {
  const sessionsDir = getProjectSessionsDir();
  try {
    const files = await fs.readdir(sessionsDir);
    const logFiles = files.filter((f) => f.endsWith(".json") && !f.includes("checkpoint"));

    const results: LogMetadata[] = [];
    for (const file of logFiles) {
      try {
        const filePath = path.join(sessionsDir, file);
        const stat = await fs.stat(filePath);
        let eventCount = 0;
        try {
          const content = await fs.readFile(filePath, "utf8");
          const parsed = JSON.parse(content);
          eventCount = Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          // Corrupt log file
        }
        results.push({
          sessionId: file.replace(".json", ""),
          filePath,
          sizeBytes: stat.size,
          mtime: stat.mtime,
          eventCount,
        });
      } catch {
        // Skip files that can't be stat'd
      }
    }

    results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return results;
  } catch {
    return [];
  }
}

/**
 * Purge session logs older than the specified number of days.
 * Supports the /logs purge --older-than Nd CLI command.
 *
 * @param olderThanDays - Delete logs older than this many days
 * @returns Number of files purged
 */
export async function purgeOldLogs(olderThanDays: number): Promise<number> {
  const sessionsDir = getProjectSessionsDir();
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  try {
    const files = await fs.readdir(sessionsDir);
    const logFiles = files.filter((f) => f.endsWith(".json") && !f.includes("checkpoint"));

    let purged = 0;
    for (const file of logFiles) {
      const filePath = path.join(sessionsDir, file);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          purged++;
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }

    return purged;
  } catch {
    return 0;
  }
}

/**
 * Export session logs to a specified directory.
 * Supports the /logs export CLI command.
 *
 * @param exportDir - Directory to export logs to
 * @returns Number of files exported
 */
export async function exportLogs(exportDir: string): Promise<number> {
  const sessionsDir = getProjectSessionsDir();
  await fs.mkdir(exportDir, { recursive: true });

  try {
    const files = await fs.readdir(sessionsDir);
    const logFiles = files.filter((f) => f.endsWith(".json"));

    let exported = 0;
    for (const file of logFiles) {
      const srcPath = path.join(sessionsDir, file);
      const destPath = path.join(exportDir, file);
      try {
        await fs.copyFile(srcPath, destPath);
        exported++;
      } catch {
        // Skip files that can't be copied
      }
    }

    return exported;
  } catch {
    return 0;
  }
}

/**
 * Format log list for CLI display.
 */
export function formatLogListForCLI(logs: LogMetadata[]): string {
  if (logs.length === 0) {
    return "No session logs found.";
  }

  const lines: string[] = [`Session Logs (${logs.length}):`, ""];

  for (const log of logs.slice(0, 20)) {
    const size = log.sizeBytes > 1024
      ? `${(log.sizeBytes / 1024).toFixed(1)}KB`
      : `${log.sizeBytes}B`;
    const date = log.mtime.toISOString().split("T")[0];
    lines.push(`  ${log.sessionId}  ${size.padEnd(8)}  ${log.eventCount} events  ${date}`);
  }

  if (logs.length > 20) {
    lines.push(`  ... and ${logs.length - 20} more`);
  }

  lines.push("");
  lines.push("Commands: /logs purge --older-than 30d | /logs export <dir>");
  return lines.join("\n");
}
