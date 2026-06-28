/**
 * Self-Diagnostics & Agent Error Recovery — US-13.4
 *
 * All tool execution, sandbox, and compilation paths wrap unhandled exceptions.
 * Errors are formatted as a structured diagnostic block containing tool name,
 * input arguments, precise stderr, compilation messages, callstack, and
 * suggested remedies.
 *
 * The diagnostic block is sent as the tool result payload in the next turn
 * rather than crashing the harness.
 *
 * Harness tracks consecutive failures. If the agent gets stuck in a loop of
 * 3 consecutive identical failures, the execution pauses and alerts the user.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface DiagnosticBlock {
  tool_name: string;
  input_args: Record<string, any>;
  error_type: string;
  error_message: string;
  stderr?: string;
  compilation_messages?: string[];
  callstack?: string;
  suggested_remedies: string[];
  timestamp: string;
}

export interface FailureTracker {
  consecutiveFailures: number;
  lastErrorHash: string | null;
  lastErrorTool: string | null;
}

// ─── Diagnostic Block Creation ───────────────────────────────────────

/**
 * Create a structured diagnostic block from an error.
 * This is sent as the tool result payload instead of crashing.
 */
export function createDiagnosticBlock(
  toolName: string,
  args: Record<string, any>,
  error: Error | any,
  options?: {
    stderr?: string;
    compilationMessages?: string[];
  },
): DiagnosticBlock {
  const errorMessage = error?.message || String(error);
  const errorType = error?.name || error?.constructor?.name || "Error";
  const callstack = error?.stack || "";

  // Generate suggested remedies based on error type
  const remedies = suggestRemedies(toolName, errorMessage, errorType);

  return {
    tool_name: toolName,
    input_args: redactArgs(args),
    error_type: errorType,
    error_message: errorMessage,
    stderr: options?.stderr,
    compilation_messages: options?.compilationMessages,
    callstack: callstack.split("\n").slice(0, 10).join("\n"),
    suggested_remedies: remedies,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format a diagnostic block as a readable string for the model.
 */
export function formatDiagnosticBlock(block: DiagnosticBlock): string {
  const lines: string[] = [
    `[DIAGNOSTIC ERROR]`,
    `Tool: ${block.tool_name}`,
    `Error Type: ${block.error_type}`,
    `Error: ${block.error_message}`,
  ];

  if (block.stderr) {
    lines.push(`Stderr: ${block.stderr.substring(0, 500)}`);
  }

  if (block.compilation_messages && block.compilation_messages.length > 0) {
    lines.push(`Compilation Messages:`);
    for (const msg of block.compilation_messages.slice(0, 5)) {
      lines.push(`  - ${msg}`);
    }
  }

  if (block.callstack) {
    lines.push(`Stack Trace:`);
    for (const line of block.callstack.split("\n").slice(0, 5)) {
      lines.push(`  ${line}`);
    }
  }

  if (block.suggested_remedies.length > 0) {
    lines.push(`Suggested Remedies:`);
    for (const remedy of block.suggested_remedies) {
      lines.push(`  - ${remedy}`);
    }
  }

  lines.push(`Input Args: ${JSON.stringify(block.input_args, null, 2).substring(0, 500)}`);

  return lines.join("\n");
}

// ─── Suggested Remedies ─────────────────────────────────────────────

/**
 * Generate suggested remedies based on the error type and tool.
 */
function suggestRemedies(toolName: string, errorMessage: string, errorType: string): string[] {
  const remedies: string[] = [];
  const lowerMsg = errorMessage.toLowerCase();

  // File not found
  if (lowerMsg.includes("no such file") || lowerMsg.includes("does not exist") || lowerMsg.includes("not found")) {
    remedies.push("Verify the file path exists. Use list_dir or glob to find the correct path.");
    remedies.push("If creating a new file, ensure the parent directory exists.");
  }

  // Permission denied
  if (lowerMsg.includes("permission denied") || lowerMsg.includes("eacces")) {
    remedies.push("Check file permissions. The file may be read-only or owned by another user.");
    remedies.push("Ensure the file is inside the workspace sandbox.");
  }

  // Write blocked (read-before-write)
  if (lowerMsg.includes("not read first") || lowerMsg.includes("writeblocked")) {
    remedies.push("Use view_file to read the file before modifying it.");
    remedies.push("This is a safety guard to prevent blind edits.");
  }

  // Stale read
  if (lowerMsg.includes("stale") || lowerMsg.includes("hash mismatch") || lowerMsg.includes("modified since")) {
    remedies.push("The file has changed since it was last read. Re-read it with view_file before writing.");
  }

  // Path sandbox
  if (lowerMsg.includes("outside") && lowerMsg.includes("workspace")) {
    remedies.push("The path resolves outside the workspace. Use a path inside the workspace root.");
  }

  // Blocked path
  if (lowerMsg.includes("blocked") && (lowerMsg.includes(".env") || lowerMsg.includes(".git") || lowerMsg.includes("secret"))) {
    remedies.push("This file is blocked by security policy (sensitive file). Use a different file.");
  }

  // Command risk
  if (lowerMsg.includes("destructive") || lowerMsg.includes("privileged") || lowerMsg.includes("exfiltration")) {
    remedies.push("The command was classified as high-risk. Consider a safer alternative.");
    remedies.push("If this is intentional, the user must approve the command.");
  }

  // Compilation errors
  if (errorType === "SyntaxError" || lowerMsg.includes("syntax") || lowerMsg.includes("compile")) {
    remedies.push("Check for syntax errors in the generated code.");
    remedies.push("Verify TypeScript types are correct.");
  }

  // Timeout
  if (lowerMsg.includes("timeout") || lowerMsg.includes("timed out")) {
    remedies.push("The operation timed out. Try breaking the task into smaller steps.");
    remedies.push("Check if the model or service is responding slowly.");
  }

  // Network
  if (lowerMsg.includes("fetch") || lowerMsg.includes("network") || lowerMsg.includes("econnrefused")) {
    remedies.push("Check network connectivity and that the service is running.");
    remedies.push("Verify the API base URL is correct in .env.");
  }

  // Generic fallback
  if (remedies.length === 0) {
    remedies.push("Review the error message and adjust the approach.");
    remedies.push("If the error persists, try a different strategy.");
  }

  return remedies;
}

// ─── Redaction ──────────────────────────────────────────────────────

/**
 * Redact sensitive values from args before including in diagnostic blocks.
 */
function redactArgs(args: Record<string, any>): Record<string, any> {
  const redacted: Record<string, any> = {};
  const sensitiveKeys = ["apiKey", "api_key", "password", "token", "secret", "key"];

  for (const [key, value] of Object.entries(args)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string" && value.length > 200) {
      redacted[key] = value.substring(0, 200) + "...";
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

// ─── Consecutive Failure Tracking ───────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Track consecutive failures to detect when the agent is stuck in a loop.
 */
export class ConsecutiveFailureTracker {
  private consecutiveFailures = 0;
  private lastErrorHash: string | null = null;
  private lastErrorTool: string | null = null;

  /**
   * Record a tool failure.
   * Returns true if the agent should be paused (3 consecutive identical failures).
   */
  recordFailure(toolName: string, error: Error | any): boolean {
    const errorHash = hashError(error);

    if (toolName === this.lastErrorTool && errorHash === this.lastErrorHash) {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 1;
      this.lastErrorTool = toolName;
      this.lastErrorHash = errorHash;
    }

    return this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  }

  /**
   * Reset the failure tracker (called on successful execution).
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.lastErrorHash = null;
    this.lastErrorTool = null;
  }

  /**
   * Get the current failure state.
   */
  get state(): FailureTracker {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastErrorHash: this.lastErrorHash,
      lastErrorTool: this.lastErrorTool,
    };
  }

  /**
   * Get the max consecutive failures threshold.
   */
  get maxConsecutiveFailures(): number {
    return MAX_CONSECUTIVE_FAILURES;
  }
}

/**
 * Hash an error for comparison (to detect identical failures).
 */
function hashError(error: Error | any): string {
  const msg = error?.message || String(error);
  const type = error?.name || "";
  // Simple hash — not cryptographic, just for comparison
  let hash = 0;
  const str = `${type}:${msg}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

// ─── Global Failure Tracker ─────────────────────────────────────────

export const globalFailureTracker = new ConsecutiveFailureTracker();