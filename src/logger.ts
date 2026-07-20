/**
 * Unified Logger — US-6.3, US-9.3, US-9.5, US-13.3, US-13.4
 *
 * Wraps session_logger.ts with:
 *   - Tamper-proof SHA-256 audit chain (US-9.5)
 *   - Diagnostic telemetry integration (US-13.4)
 *   - Retry attempt logging with jitter (US-6.3)
 *   - Secret redaction before disk (US-9.3)
 *   - Log retention commands (US-13.3)
 *
 * Audit Chain:
 *   H_n = SHA-256(H_{n-1} + action_payload)
 *   Each action (command, file mutation, tool call) appends a hash.
 *   Any manual alteration of session logs breaks the verification chain.
 */

import {
  SessionLogger,
  sanitizeLogData,
  truncateForLog,
  safeStringify,
  listSessionLogs,
  purgeOldLogs,
  exportLogs,
  formatLogListForCLI,
  type LogMetadata,
} from "./session_logger.js";
import { redactSecrets } from "./security/secrets.js";
import { config } from "./config.js";
import { getProjectSessionsDir } from "./paths.js";
import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";

// ─── Audit Chain ─────────────────────────────────────────────────────
// The AuditChain class lives in src/audit_chain.ts (extracted so the
// SessionLogger can own a chain without a circular import). It is
// re-exported here so existing imports (`from "./logger.js"`) keep working.
export { AuditChain, type AuditEntry } from "./audit_chain.js";
import { AuditChain, type AuditEntry } from "./audit_chain.js";

// ─── Unified Logger ──────────────────────────────────────────────────

export class Logger {
  private sessionLogger: SessionLogger;
  private auditChain: AuditChain;
  private auditLogPath: string;

  constructor() {
    this.sessionLogger = new SessionLogger();
    this.auditChain = new AuditChain();
    this.auditLogPath = path.join(
      getProjectSessionsDir(),
      `${this.sessionLogger.getSessionId()}_audit.json`,
    );
  }

  /**
   * Log a general event (backwards compatibility).
   */
  logEvent(type: string, data: any): void {
    this.sessionLogger.logEvent(type, data);
  }

  /**
   * Log a tool execution with diagnostic telemetry.
   */
  logToolCall(toolName: string, args: Record<string, any>, result?: any, error?: Error): void {
    const payload = safeStringify({ tool: toolName, args: this.redactArgs(args), error: error?.message });
    this.auditChain.appendEntry("tool_call", payload);
    this.sessionLogger.logEvent("tool_result", {
      tool: toolName,
      callId: undefined,
      result: error ? `Error: ${error.message}` : result,
    });
  }

  /**
   * Log a file read operation.
   */
  logFileRead(filePath: string, size: number, hash: string): void {
    const payload = safeStringify({ path: filePath, size, sha256: hash });
    this.auditChain.appendEntry("file_read", payload);
    this.sessionLogger.logEvent("file_read", { path: filePath, size, sha256: hash });
  }

  /**
   * Log a file write operation.
   */
  logFileWrite(filePath: string, size: number, backupPath?: string): void {
    const payload = safeStringify({ path: filePath, size, backup: backupPath });
    this.auditChain.appendEntry("file_write", payload);
    this.sessionLogger.logEvent("file_write", { path: filePath, size, backup: backupPath });
  }

  /**
   * Log a command execution.
   */
  logCommand(command: string, riskClass: string, approved: boolean, exitCode?: number): void {
    const payload = safeStringify({ command: redactSecrets(command), risk: riskClass, approved, exitCode });
    this.auditChain.appendEntry("command_exec", payload);
    this.sessionLogger.logEvent("command_exec", { command: redactSecrets(command), risk: riskClass, approved, exitCode });
  }

  /**
   * Log an approval action.
   */
  logApproval(action: string, approved: boolean, hash: string): void {
    const payload = safeStringify({ action, approved, hash });
    this.auditChain.appendEntry("approval", payload);
    this.sessionLogger.logEvent("approval", { action, approved, hash });
  }

  /**
   * Log evidence / provenance for a deliverable (SPEC §16 / §11.3 / §7.5).
   * Records what context and sources produced a draft — the reproducibility
   * statement required by the Definition of Done.
   *
   * The provenance fields are included in the hashed payload so the chain
   * is tamper-evident — modifying source_ids or context_used after the fact
   * would break the hash chain.
   */
  logEvidenceProvenance(entry: {
    deliverablePath: string;
    sourceIds: string[];
    sourceRefs: string[];
    contextUsed: string;
    evidenceRef?: string;
  }): void {
    // Include provenance in the hashed payload so the chain covers it
    // (SPEC §11.3 tamper-evidence). The provenance fields below are a
    // cached copy DERIVED from the (redacted) payload the chain hashed,
    // so verifyChain() can confirm they were not altered after the fact.
    const provenance = `${entry.sourceIds.length} sources → ${entry.deliverablePath}`;
    const payload = safeStringify({
      deliverable: entry.deliverablePath,
      source_ids: entry.sourceIds,
      source_refs: entry.sourceRefs,
      context_used: entry.contextUsed,
      evidence_ref: entry.evidenceRef,
      provenance,
    });
    const auditEntry = this.auditChain.appendEntry("evidence", payload);
    // Derive the convenience fields from the payload the chain actually
    // hashed (post-redaction) so they always match under verifyChain().
    let reflected: any = {};
    try {
      reflected = JSON.parse(auditEntry.action_payload);
    } catch {
      reflected = {};
    }
    auditEntry.source_ids = reflected.source_ids;
    auditEntry.source_refs = reflected.source_refs;
    auditEntry.context_used = reflected.context_used;
    auditEntry.provenance = reflected.provenance;
    auditEntry.evidence_ref = reflected.evidence_ref;
    this.sessionLogger.logEvent("evidence_provenance", {
      deliverable: entry.deliverablePath,
      source_ids: entry.sourceIds,
      source_refs: entry.sourceRefs,
      context_used: entry.contextUsed,
      evidence_ref: entry.evidenceRef,
    });
  }

  /**
   * Log a retry attempt with backoff timing.
   * W(n) = min(W_max, W_base × 2^n) + J
   */
  logRetry(toolName: string, attempt: number, delayMs: number, error: Error): void {
    const payload = safeStringify({
      tool: toolName,
      attempt,
      delayMs,
      error: error.message,
    });
    this.sessionLogger.logEvent("tool_retry", {
      tool: toolName,
      attempt,
      delayMs,
      error: error.message,
    });
  }

  /**
   * Log a diagnostic block (US-13.4).
   */
  logDiagnostic(diagnostic: {
    tool_name: string;
    error_type: string;
    error_message: string;
    suggested_remedies: string[];
  }): void {
    this.sessionLogger.logEvent("diagnostic", diagnostic);
  }

  /**
   * Log user input.
   */
  logUserInput(content: string): void {
    this.sessionLogger.logEvent("user_input", { content });
  }

  /**
   * Log assistant response.
   */
  logAssistantResponse(content: string, toolCalls?: any[]): void {
    this.sessionLogger.logEvent("assistant_response", {
      role: "assistant",
      content,
      tool_calls: toolCalls,
    });
  }

  /**
   * Log an API error.
   */
  logApiError(error: string, status: number, response: string, retries: number): void {
    this.sessionLogger.logEvent("api_error", {
      error,
      status,
      retries,
      response,
    });
  }

  /**
   * Flush session logs and audit chain to disk.
   */
  async flush(): Promise<void> {
    // Write audit chain
    try {
      await fs.mkdir(path.dirname(this.auditLogPath), { recursive: true });
      await fs.writeFile(this.auditLogPath, this.auditChain.serialize(), "utf8");
    } catch {
      // Audit chain write failure is non-critical
    }

    // Flush session logger
    await this.sessionLogger.flush();
  }

  /**
   * Synchronous flush for exit handlers.
   */
  flushSync(): void {
    try {
      fsSync.mkdirSync(path.dirname(this.auditLogPath), { recursive: true });
      fsSync.writeFileSync(this.auditLogPath, this.auditChain.serialize(), "utf8");
    } catch {
      // Non-critical
    }
    this.sessionLogger.flushSync();
  }

  /**
   * Verify the audit chain integrity.
   */
  verifyAuditChain(): boolean {
    return this.auditChain.verifyChain();
  }

  /**
   * Get the audit chain entries.
   */
  getAuditEntries(): AuditEntry[] {
    return this.auditChain.getEntries();
  }

  /**
   * Get the session logger (for compatibility).
   */
  getSessionLogger(): SessionLogger {
    return this.sessionLogger;
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string {
    return this.sessionLogger.getSessionId();
  }

  /**
   * Get the session log relative path.
   */
  getSessionLogRelPath(): string {
    return this.sessionLogger.getSessionLogRelPath();
  }

  /**
   * Get the audit log path.
   */
  getAuditLogPath(): string {
    return this.auditLogPath;
  }

  /**
   * Redact sensitive args.
   */
  private redactArgs(args: Record<string, any>): Record<string, any> {
    const redacted: Record<string, any> = {};
    const sensitiveKeys = ["apiKey", "api_key", "password", "token", "secret", "key"];

    for (const [key, value] of Object.entries(args)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        redacted[key] = "[REDACTED]";
      } else if (typeof value === "string" && value.length > 500) {
        redacted[key] = value.substring(0, 500) + "...";
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }
}

// ─── Retry Backoff with Jitter (US-6.3) ──────────────────────────────

/**
 * Calculate retry delay with exponential backoff and jitter.
 * W(n) = min(W_max, W_base × 2^n) + J
 *
 * @param attempt - Zero-based attempt number
 * @param baseMs - Base delay (default 500ms per spec)
 * @param maxMs - Maximum delay cap (default 30000ms)
 * @returns Delay in milliseconds
 */
export function calculateBackoffWithJitter(
  attempt: number,
  baseMs: number = 500,
  maxMs: number = 30000,
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = Math.random() * baseMs; // J ∈ [0, W_base)
  return Math.round(exponential + jitter);
}

// ─── Re-exports for convenience ──────────────────────────────────────

export {
  listSessionLogs,
  purgeOldLogs,
  exportLogs,
  formatLogListForCLI,
  redactSecrets,
  sanitizeLogData,
  truncateForLog,
  safeStringify,
  type LogMetadata,
};
