import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import picocolors from "picocolors";
import readline from "readline";
import { config } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { loadCoreMemory } from "./state.js";
import { statusLine, theme } from "./cli_ui.js";
import {
  maybeShowCloudNotice,
  ensureCloudDataDir,
  autoSyncToCloud,
} from "./cloud_sync.js";

// ─── Vision: Image encoding ───────────────────────────────────────────
// Detects [Image: path] markers in user input, validates the file is a
// real image (by magic bytes, not just extension), reads it, and encodes
// as base64 data URL for the OpenAI-compatible vision API.
// Security: only local files, no path traversal, size-limited, magic-byte validated.

const IMAGE_MAGIC: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47],
  jpg: [0xff, 0xd8, 0xff],
  jpeg: [0xff, 0xd8, 0xff],
  gif: [0x47, 0x49, 0x46, 0x38],
  bmp: [0x42, 0x4d],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF header
};

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Validate that a file is a real image by checking magic bytes.
 * Prevents disguised malicious files (e.g. a script renamed to .png).
 */
function validateImageMagic(filePath: string): string | null {
  try {
    const fd = fsSync.openSync(filePath, "r");
    const header = Buffer.alloc(12);
    fsSync.readSync(fd, header, 0, 12, 0);
    fsSync.closeSync(fd);

    for (const [ext, magic] of Object.entries(IMAGE_MAGIC)) {
      if (header.subarray(0, magic.length).equals(Buffer.from(magic))) {
        return ext;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode an image file as a base64 data URL.
 * Returns null if the file is not a valid image or is too large.
 */
async function encodeImageAsDataURL(filePath: string): Promise<string | null> {
  try {
    // Resolve and check the path is real (no symlinks to /etc/passwd etc.)
    const resolved = path.resolve(filePath);
    const stat = await fs.stat(resolved);

    if (!stat.isFile()) return null;
    if (stat.size > MAX_IMAGE_SIZE) {
      console.error(
        picocolors.yellow(
          `   ⚠️  Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 20MB limit): ${resolved}`,
        ),
      );
      return null;
    }

    // Validate by magic bytes, not extension
    const ext = validateImageMagic(resolved);
    if (!ext) {
      console.error(
        picocolors.yellow(
          `   ⚠️  Not a valid image file (magic bytes mismatch): ${resolved}`,
        ),
      );
      return null;
    }

    const data = await fs.readFile(resolved);
    const base64 = data.toString("base64");
    return `data:image/${ext};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Detect [Image: path] markers in user input and convert to vision message parts.
 * Returns the message content as either a string (no images) or an array
 * of text and image_url parts (OpenAI vision format).
 *
 * Security:
 *   - Only local file paths (no URLs)
 *   - Magic-byte validation (can't disguise scripts as images)
 *   - Size-limited (20MB max)
 *   - Path traversal blocked (path.resolve + stat)
 */
async function processImageMarkers(
  input: string,
): Promise<string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
>> {
  const imageMarker = /\[Image:\s*([^\]]+)\]/g;
  const matches = [...input.matchAll(imageMarker)];

  if (matches.length === 0) return input;

  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];

  let lastIdx = 0;
  let imagesEncoded = 0;

  for (const match of matches) {
    const matchStart = match.index!;
    const matchEnd = matchStart + match[0].length;
    const rawPath = match[1].trim();

    // Add any text before this marker
    if (matchStart > lastIdx) {
      const textBefore = input.substring(lastIdx, matchStart).trim();
      if (textBefore) parts.push({ type: "text", text: textBefore });
    }

    // Encode the image
    const dataUrl = await encodeImageAsDataURL(rawPath);
    if (dataUrl) {
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
      imagesEncoded++;
    } else {
      // Include the failed marker as text so the agent knows
      parts.push({
        type: "text",
        text: `[Image: ${rawPath} — could not load. The file may not exist, may not be a valid image, or may be too large.]`,
      });
    }

    lastIdx = matchEnd;
  }

  // Add any remaining text after the last marker
  if (lastIdx < input.length) {
    const textAfter = input.substring(lastIdx).trim();
    if (textAfter) parts.push({ type: "text", text: textAfter });
  }

  if (imagesEncoded > 0 && config.outputMode === "interactive") {
    console.log(
      picocolors.gray(
        `   📎 ${imagesEncoded} image${imagesEncoded > 1 ? "s" : ""} encoded for vision`,
      ),
    );
  }

  return parts;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** Events emitted during prompt execution for GUI consumption. */
export interface AgentEvent {
  type: "token" | "tool_call" | "tool_result" | "approval" | "done" | "error";
  data: {
    text?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
    approved?: boolean;
    response?: string;
    error?: string;
    tokenStats?: {
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      turns: number;
    };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

function truncateForLog(
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

const SECRET_PATTERNS: RegExp[] = [
  // .env KEY=VALUE lines for known secret keys
  /^(LLM_API_KEY|PARALLEL_API_KEY|OLLAMA_API_KEY|GITHUB_TOKEN|CONTEXT7_API_KEY|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*=\s*.+$/gim,
  // Bearer tokens in Authorization headers
  /Bearer\s+[A-Za-z0-9_\-\.]+/gi,
  // GitHub tokens (ghp_, gho_, ghs_, ghu_)
  /gh[pousr]_[A-Za-z0-9]{36,}/gi,
  // OpenRouter-style keys (sk-or-v1-...)
  /sk-or-v1-[A-Za-z0-9]+/gi,
  // OpenAI-style keys (sk-...)
  /sk-[A-Za-z0-9]{20,}/gi,
  // Ollama API keys (hex hash format)
  /[a-f0-9]{32}\.[A-Za-z0-9_\-]+/gi,
  // Parallel.ai API keys
  /[A-Za-z0-9]{8}-[A-Za-z0-9_\-]{20,}/gi,
  // Generic long hex/base64 strings that look like API keys (40+ chars)
  /[A-Za-z0-9_\-]{40,}/g,
];

const REDACTED = "[REDACTED]";

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function sanitizeLogData(type: string, data: any): any {
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
        typeof result === "string" ? result : JSON.stringify(result ?? "");
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

export class SessionLogger {
  private sessionId: string;
  private logPath: string;
  private logs: any[] = [];
  private dirEnsured = false;

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.logPath = path.resolve(".sessions", `${this.sessionId}.json`);
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
    return `.sessions/${this.sessionId}.json`;
  }
}

// Helper to format arguments/details beautifully, folding large text blocks (like raw code)
function formatDetails(toolName: string, args: any, prefix: string): string {
  if (typeof args !== "object" || args === null) {
    return `${prefix}${JSON.stringify(args)}`;
  }

  const cloned = { ...args };
  const foldFields = [
    "content",
    "replacementContent",
    "code",
    "text",
    "replacement",
  ];
  const foldedDetails: { fieldName: string; originalValue: string }[] = [];

  for (const field of foldFields) {
    if (typeof cloned[field] === "string") {
      foldedDetails.push({ fieldName: field, originalValue: cloned[field] });
      delete cloned[field];
    }
  }

  let output = "";
  const otherKeys = Object.keys(cloned);
  if (otherKeys.length > 0) {
    output += JSON.stringify(cloned, null, 2);
  }

  for (const item of foldedDetails) {
    const rawVal = item.originalValue;
    const lines = rawVal.split("\n");
    let contentBlock = "";

    if (lines.length <= 15) {
      contentBlock = rawVal;
    } else {
      const startLines = lines.slice(0, 8).join("\n");
      const endLines = lines.slice(-5).join("\n");
      const foldedCount = lines.length - 13;
      contentBlock = `${startLines}\n${picocolors.gray(`\n  ... [${foldedCount} lines of code folded to keep screen clean] ...\n`)}\n${endLines}`;
    }

    if (output) {
      output += "\n";
    }
    output += `${picocolors.cyan(`${item.fieldName}:`)}\n${picocolors.white(contentBlock)}`;
  }

  return output
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

// Approval gate prompt — reuse the session readline when provided to avoid double-echo (yy)
async function askUserApproval(
  toolName: string,
  args: any,
  sessionRl?: readline.Interface,
): Promise<boolean> {
  const displayName = Agent.getToolDisplayName(toolName);

  // Detect irreversible actions for stronger warning (Principle: Reversibility Awareness)
  const irreversible = isIrreversibleAction(toolName, args);

  console.log(picocolors.yellow(`\n┌── Permission required ${"─".repeat(25)}`));
  console.log(picocolors.yellow(`│  Quiver wants to:`));
  console.log(picocolors.yellow(`│  `));
  console.log(picocolors.yellow(`│  Action: `) + picocolors.green(displayName));
  console.log(picocolors.yellow(`│  Details:`));
  console.log(formatDetails(toolName, args, picocolors.yellow(`│    `)));
  if (irreversible) {
    console.log(
      picocolors.red(`│  ⚠ IRREVERSIBLE: This action cannot be undone.`),
    );
  }
  console.log(
    picocolors.yellow(
      `└───────────────────────────────────────────────────────────`,
    ),
  );

  const prompt = irreversible
    ? picocolors.bold(picocolors.red("⚠ IRREVERSIBLE. Confirm? (y/N): "))
    : picocolors.bold(picocolors.cyan("Allow this action? (y/N): "));

  if (sessionRl) {
    return new Promise((resolve) => {
      sessionRl.question(prompt, (answer) => {
        const cleanAnswer = answer.trim().toLowerCase();
        resolve(cleanAnswer === "y" || cleanAnswer === "yes");
      });
    });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const cleanAnswer = answer.trim().toLowerCase();
      resolve(cleanAnswer === "y" || cleanAnswer === "yes");
    });
  });
}

/** Detect irreversible actions that warrant a stronger warning. */
function isIrreversibleAction(toolName: string, args: any): boolean {
  if (toolName === "run_command" && args?.command) {
    const cmd = args.command.toLowerCase();
    // Check for rm -rf, force push, drop, delete, format, dd, mkfs
    if (
      /\brm\s+(-[a-z]*r[a-z]*f|f[a-z]*r[a-z]*)\b/.test(cmd) ||
      /git\s+push.*--force/.test(cmd) ||
      /git\s+push.*-f\b/.test(cmd) ||
      /\b(drop|delete|truncate)\b/.test(cmd) ||
      /\b(mkfs|dd\s+if=|format\s+)\b/.test(cmd)
    ) {
      return true;
    }
  }
  return false;
}

// Simple spinner for streaming UX
class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private interval: ReturnType<typeof setInterval> | null = null;
  private message: string;
  private active = false;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    if (this.active || config.outputMode !== "interactive") return;
    if (!process.stdout.isTTY) return;
    this.active = true;
    let i = 0;
    process.stdout.write("\r");
    this.interval = setInterval(() => {
      process.stdout.write(
        `\r${picocolors.cyan(this.frames[i % this.frames.length])} ${picocolors.gray(this.message)}`,
      );
      i++;
    }, 80);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write("\r" + " ".repeat(this.message.length + 4) + "\r");
  }
}

export class Agent {
  private registry: ToolRegistry;
  private messages: Message[] = [];
  private logger: SessionLogger;
  private tokenStats = {
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    turns: 0,
  };
  private sessionReadline: readline.Interface | null = null;
  // Track files read in the current session for read-before-write enforcement
  private filesReadThisSession: Set<string> = new Set();
  // Cloud sync: show notice once per session
  private cloudSyncInitialized = false;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    this.logger = new SessionLogger();

    // Add default system prompt structure (will be dynamically updated with skills and memory)
    this.messages.push({
      role: "system",
      content:
        "You are Quiver, a self-evolving coding and research assistant running in a terminal-based CLI.",
    });
  }

  // ─── Session persistence ─────────────────────────────────────────────
  // Auto-saves conversation state to disk so it can be resumed after exit/crash.
  // Modeled after Codex CLI and Claude Code session persistence.

  private getSessionStatePath(): string {
    return path.resolve(
      ".sessions",
      `${this.logger.getSessionId()}.state.json`,
    );
  }

  /** Save the current conversation state (messages + token stats) to disk. */
  public async saveSessionState(): Promise<void> {
    try {
      const statePath = this.getSessionStatePath();
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      const state = {
        format: "quiver-session-state",
        version: "1.0.0",
        sessionId: this.logger.getSessionId(),
        savedAt: new Date().toISOString(),
        model: config.llmModelName,
        messages: this.getRedactedMessages(),
        tokenStats: this.tokenStats,
      };
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // Fail silently — session state saving is best-effort
    }
  }

  /** Synchronous version of saveSessionState for use in signal handlers. */
  public saveSessionStateSync(): void {
    try {
      const statePath = this.getSessionStatePath();
      fsSync.mkdirSync(path.dirname(statePath), { recursive: true });
      const state = {
        format: "quiver-session-state",
        version: "1.0.0",
        sessionId: this.logger.getSessionId(),
        savedAt: new Date().toISOString(),
        model: config.llmModelName,
        messages: this.getRedactedMessages(),
        tokenStats: this.tokenStats,
      };
      fsSync.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // Fail silently — session state saving is best-effort
    }
    // Flush session logs to disk (buffered — no per-event I/O)
    this.logger.flushSync();
  }

  /**
   * Returns a deep copy of messages with secrets redacted from tool results
   * and content. Used for safe persistence to disk.
   */
  private getRedactedMessages(): Message[] {
    return this.messages.map((msg) => {
      const redacted: Message = {
        role: msg.role,
        content:
          typeof msg.content === "string"
            ? redactSecrets(msg.content)
            : msg.content,
        name: msg.name,
        tool_call_id: msg.tool_call_id,
      };
      if (msg.tool_calls) {
        redacted.tool_calls = msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: redactSecrets(tc.function.arguments),
          },
        }));
      }
      return redacted;
    });
  }

  /** Load conversation state from a previous session file. */
  public async loadSessionState(statePath: string): Promise<boolean> {
    try {
      const content = await fs.readFile(statePath, "utf8");
      const state = JSON.parse(content);
      if (state.format !== "quiver-session-state") {
        return false;
      }
      // Restore messages (the system prompt will be rebuilt on next prompt())
      this.messages = state.messages || [];
      this.tokenStats = state.tokenStats || {
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        turns: 0,
      };
      return true;
    } catch {
      return false;
    }
  }

  /** Find the most recent session state file in .sessions/ */
  public static async findLatestSessionState(): Promise<string | null> {
    try {
      const sessionsDir = path.resolve(".sessions");
      const files = await fs.readdir(sessionsDir);
      const stateFiles = files
        .filter((f) => f.endsWith(".state.json"))
        .map((f) => ({
          name: f,
          path: path.join(sessionsDir, f),
        }))
        .sort((a, b) => b.name.localeCompare(a.name)); // newest first (timestamp in name)

      // Return the most recently modified file
      let latest: { path: string; mtime: number } | null = null;
      for (const f of stateFiles) {
        const stat = await fs.stat(f.path);
        if (!latest || stat.mtimeMs > latest.mtime) {
          latest = { path: f.path, mtime: stat.mtimeMs };
        }
      }
      return latest?.path || null;
    } catch {
      return null;
    }
  }

  /** List all saved session state files with metadata. */
  public static async listSessionStates(): Promise<
    {
      sessionId: string;
      path: string;
      savedAt: string;
      messageCount: number;
      model: string;
    }[]
  > {
    try {
      const sessionsDir = path.resolve(".sessions");
      const files = await fs.readdir(sessionsDir);
      const stateFiles = files.filter((f) => f.endsWith(".state.json"));

      const results: {
        sessionId: string;
        path: string;
        savedAt: string;
        messageCount: number;
        model: string;
      }[] = [];

      for (const f of stateFiles) {
        try {
          const filePath = path.join(sessionsDir, f);
          const content = await fs.readFile(filePath, "utf8");
          const state = JSON.parse(content);
          results.push({
            sessionId: state.sessionId || f,
            path: filePath,
            savedAt: state.savedAt || "unknown",
            messageCount: state.messages?.length || 0,
            model: state.model || "unknown",
          });
        } catch {
          // Skip corrupt files
        }
      }

      // Sort by savedAt descending (newest first)
      results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      return results;
    } catch {
      return [];
    }
  }

  public getMessages(): Message[] {
    return this.messages;
  }

  public getMessageCount(): number {
    return this.messages.length;
  }

  public getTokenStats() {
    return { ...this.tokenStats };
  }

  public addMessage(message: Message): void {
    this.messages.push(message);
  }

  public getSessionId(): string {
    return this.logger.getSessionId();
  }

  public getSessionLogRelPath(): string {
    return this.logger.getSessionLogRelPath();
  }

  /** Share the CLI readline so approval prompts don't open a second listener on stdin. */
  public setSessionReadline(rl: readline.Interface): void {
    this.sessionReadline = rl;
  }

  // Compact conversation history to save context window space.
  // Keeps the system prompt + last N messages, summarizes older ones.
  public compactHistory(keepLast: number = 10): number {
    if (this.messages.length <= keepLast + 1) return 0;

    const systemMsg = this.messages.find((m) => m.role === "system");
    let recentMessages = this.messages.slice(-keepLast);
    const removedCount = this.messages.length - keepLast - (systemMsg ? 1 : 0);

    // Don't start with orphaned tool messages whose parent assistant
    // tool_calls were compacted away — the API would reject them.
    while (
      recentMessages.length > 0 &&
      recentMessages[0].role === "tool" &&
      !recentMessages.some(
        (m) =>
          m.role === "assistant" &&
          m.tool_calls?.some((tc) => tc.id === recentMessages[0].tool_call_id),
      )
    ) {
      recentMessages = recentMessages.slice(1);
    }

    this.messages = [];
    if (systemMsg) {
      this.messages.push(systemMsg);
    }
    // Add a summary marker for compacted history
    this.messages.push({
      role: "system",
      content: `[Context Compacted] ${removedCount} earlier messages were summarized to save context window space. The conversation continues from the recent messages below.`,
    });
    this.messages.push(...recentMessages);

    return removedCount;
  }

  // Reset conversation but keep system prompt and core memory
  public resetConversation(): void {
    const systemMsg = this.messages.find((m) => m.role === "system");
    this.messages = systemMsg ? [systemMsg] : [];
    this.tokenStats = {
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      turns: 0,
    };
  }

  // Load persistent memory files
  private async loadMemory(): Promise<
    { filename: string; sizeBytes: number; content: string }[]
  > {
    const memoryDir = path.resolve(config.memoryDir);
    const results: { filename: string; sizeBytes: number; content: string }[] =
      [];

    try {
      await fs.mkdir(memoryDir, { recursive: true });
      const files = await fs.readdir(memoryDir);

      for (const file of files) {
        const filePath = path.join(memoryDir, file);
        const stats = await fs.stat(filePath);
        if (stats.isFile() && !file.startsWith(".")) {
          const content = await fs.readFile(filePath, "utf8");
          results.push({
            filename: file,
            sizeBytes: stats.size,
            content,
          });
        }
      }
    } catch (e) {
      // Ignore directory read errors
    }
    return results;
  }

  // Load versioned skills
  private async loadSkills(): Promise<
    { id: string; version: string; purpose: string; content: string }[]
  > {
    const skillsDir = path.resolve(config.skillsDir);
    const results: {
      id: string;
      version: string;
      purpose: string;
      content: string;
    }[] = [];

    try {
      await fs.mkdir(skillsDir, { recursive: true });
      const dirs = await fs.readdir(skillsDir);

      for (const dir of dirs) {
        if (dir.startsWith(".")) continue;
        const skillPath = path.join(skillsDir, dir, "SKILL.md");
        try {
          const stats = await fs.stat(skillPath);
          if (stats.isFile()) {
            const content = await fs.readFile(skillPath, "utf8");

            // Parse YAML-like frontmatter fields
            const nameMatch = content.match(/name:\s*([^\n]+)/i);
            const verMatch = content.match(/version:\s*([^\n]+)/i);
            const purposeMatch = content.match(/purpose:\s*([^\n]+)/i);
            const descMatch = content.match(/description:\s*([^\n]+)/i);
            const licenseMatch = content.match(/license:\s*([^\n]+)/i);
            const compatMatch = content.match(/compatibility:\s*([^\n]+)/i);

            const name = nameMatch ? nameMatch[1].trim() : dir;
            const version = verMatch ? verMatch[1].trim() : "1.0.0";
            const purpose = purposeMatch
              ? purposeMatch[1].trim()
              : descMatch
                ? descMatch[1].trim()
                : "Custom task procedure";
            const license = licenseMatch ? licenseMatch[1].trim() : "Unknown";
            const compatibility = compatMatch
              ? compatMatch[1].trim()
              : "Universal";

            results.push({
              id: name,
              version,
              purpose: `${purpose} [License: ${license}, Compatibility: ${compatibility}]`,
              content,
            });
          }
        } catch (err) {
          // No SKILL.md found in this directory
        }
      }
    } catch (e) {
      // Ignore skills loader errors
    }
    return results;
  }

  /**
   * Build the rich dynamic system instructions.
   * Loads the base prompt from skills/system-prompt/SKILL.md (editable by users),
   * then appends core memory, persistent memories, and active skills.
   * The ${MODEL} placeholder is replaced with the actual model name.
   *
   * Transparency of Context: the system prompt is a visible, editable file.
   * Users can see exactly what instructions the agent receives via /memory.
   */
   private buildSystemPrompt(
    coreMemory: any,
    memories: any[],
    skills: any[],
  ): string {
    // Load base system prompt from skill file (falls back to hardcoded if missing)
    let systemPrompt: string;
    try {
      const promptPath = path.resolve(
        config.skillsDir,
        "system-prompt",
        "SKILL.md",
      );
      const rawContent = fsSync.readFileSync(promptPath, "utf8");
      // Strip YAML frontmatter
      systemPrompt = rawContent.replace(/^---[\s\S]*?---\s*/, "");
      // Replace ${MODEL} placeholder
      systemPrompt = systemPrompt.replace(/\$\{MODEL\}/g, config.llmModelName);
    } catch {
      // Fallback if skill file doesn't exist
      systemPrompt = `You are Quiver, an elite autonomous coding and research assistant running in a terminal-based CLI.
You are powered by model ${config.llmModelName} and have access to file operations, browser automation, shell command execution, web search, and more.

--- Core Principles ---
1. READ BEFORE WRITE: Always use view_file to read a file before modifying it.
2. MINIMAL EDITS: Prefer replace_content for targeted edits over write_file for full rewrites.
3. VERIFY AFTER CHANGES: After making code changes, run run_tests to validate.
4. EXPLORE FIRST: Use list_dir and view_file to understand project structure before making changes.
5. NO HALLUCINATION: Never fabricate file paths, function names, or APIs.
6. ERROR RECOVERY: When a tool fails, analyze the error, adjust your approach, and retry.
7. PROGRESSIVE DISCLOSURE: Work incrementally — make a change, verify it, then move to the next step.
8. NO SILENT ACTIONS: Every action you take is visible to the user.
9. PROVENANCE: When you state a fact, it must come from a file you read, not from memory or inference.
10. REVERSIBILITY AWARENESS: Distinguish between reversible and irreversible actions.

--- Vision ---
- When the user attaches images via [Image: path] markers, the image is encoded and sent to you as vision content.
- You can see and analyze the image directly — describe what you see, read text from screenshots, analyze diagrams.

Be concise, clear, and direct. Use tools logically to solve the task at hand.`;
    }

    // Append core memory blocks
    systemPrompt += `\n\n--- CORE MEMORY BLOCKS ---
[Identity]: ${coreMemory.identity}
[Human Context]: ${coreMemory.human_context}
[Project Context]: ${coreMemory.project_context}\n`;

    // Append persistent memories
    if (memories.length > 0) {
      systemPrompt += `\n--- ACTIVE PERSISTENT MEMORY ---\n`;
      for (const m of memories) {
        systemPrompt += `[Memory Snippet: ${m.filename}]\n${m.content}\n\n`;
      }
    }

    // Append active skills (excluding the system-prompt skill itself)
    const activeSkills = skills.filter(
      (s) => s.id !== "quiver-system-prompt",
    );
    if (activeSkills.length > 0) {
      systemPrompt += `\n--- ACTIVE TASK PROCEDURES (SKILLS) ---\n`;
      for (const s of activeSkills) {
        systemPrompt += `[Skill: ${s.id} (v${s.version})]\nPurpose: ${s.purpose}\nInstructions:\n${s.content}\n\n`;
      }
    }

    return systemPrompt;
  }

  /**
   * Estimate token count for a message (rough heuristic: ~4 chars per token).
   */
  private estimateTokens(text: string): number {
    return Math.ceil((text || "").length / 4);
  }

  /**
   * Trims conversation history if it exceeds the configured max context size.
   * Keeps the system prompt and most recent messages, removing oldest tool/user exchanges.
   */
  private trimContextIfNeeded(): number {
    const maxTokens = config.maxContextTokens;
    if (maxTokens <= 0) return 0;

    // Estimate total tokens in conversation
    let totalTokens = 0;
    for (const msg of this.messages) {
      if (msg.content) {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join(" ")
              : "";
        totalTokens += this.estimateTokens(text);
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalTokens += this.estimateTokens(tc.function.arguments);
        }
      }
    }

    if (totalTokens <= maxTokens) return 0;

    // Remove oldest non-system messages (keep system + last ~20 messages)
    const keepRecent = 20;
    if (this.messages.length <= keepRecent + 1) return 0;

    const systemMessages = this.messages.filter((m) => m.role === "system");
    const nonSystemMessages = this.messages.filter((m) => m.role !== "system");
    let keptNonSystem = nonSystemMessages.slice(-keepRecent);

    // Ensure we don't start with orphaned tool messages (whose parent
    // assistant tool_calls were trimmed away). The API rejects requests
    // where a tool message references a tool_call_id that doesn't exist.
    while (
      keptNonSystem.length > 0 &&
      keptNonSystem[0].role === "tool" &&
      !keptNonSystem.some(
        (m) =>
          m.role === "assistant" &&
          m.tool_calls?.some((tc) => tc.id === keptNonSystem[0].tool_call_id),
      )
    ) {
      keptNonSystem = keptNonSystem.slice(1);
    }

    const removedCount = nonSystemMessages.length - keptNonSystem.length;
    this.messages = [...systemMessages, ...keptNonSystem];
    return removedCount;
  }

  // ── Human-friendly tool names ──────────────────────────────────────
  // Maps internal tool IDs to plain-language names for display.
  // Internal IDs stay unchanged for the LLM; only display changes.
  private static readonly TOOL_DISPLAY_NAMES: Record<string, string> = {
    view_file: "Read file",
    write_file: "Write file",
    replace_content: "Edit file",
    list_dir: "List folder",
    format_code: "Format code",
    grep_search: "Search files",
    run_command: "Run command",
    run_tests: "Run tests",
    create_tool: "Create tool",
    log_tokens: "Log stats",
    web_search: "Web search",
    scrape_url: "Read webpage",
    search_docs: "Search docs",
    browser_control: "Browser",
    memory_append: "Save memory",
    memory_replace: "Update memory",
    github: "GitHub",
    deep_research: "Deep research",
    find_all: "Find entities",
    entity_search: "Entity search",
  };

  /** Get human-friendly name for a tool, falling back to the raw ID. */
  public static getToolDisplayName(toolName: string): string {
    return Agent.TOOL_DISPLAY_NAMES[toolName] || toolName;
  }

  /** Extract the most relevant argument for inline display (file path, URL, etc.) */
  private summarizeToolArgs(toolName: string, args: any): string {
    if (!args || typeof args !== "object") return "";
    // Priority fields by tool type
    const fields = [
      "filePath",
      "url",
      "command",
      "pattern",
      "directoryPath",
      "repo",
      "query",
      "filename",
      "action",
    ];
    for (const field of fields) {
      if (args[field] && typeof args[field] === "string") {
        // Truncate long values
        const val = args[field];
        return val.length > 60 ? `${val.substring(0, 57)}…` : val;
      }
    }
    return "";
  }

  /** Generate a truncated preview of a tool result for user display. */
  private summarizeResult(result: any): string {
    if (!result) return "";
    const str = typeof result === "string" ? result : JSON.stringify(result);
    if (str.length <= 120) return str;
    // Truncate to 120 chars, preserving word boundaries
    const truncated = str.substring(0, 117);
    const lastSpace = truncated.lastIndexOf(" ");
    const clean =
      lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated;
    return `${clean}…`;
  }

  // ── Context Manifest ───────────────────────────────────────────────
  // Shows the user exactly what context will enter the model call:
  // memory, skills, tools, model, and context window usage — before the call.
  // This is the core transparency principle: the user should never wonder
  // "what did the AI see?" or "how much context is left?"
  private printContextManifest(
    memories: any[],
    skills: any[],
    coreMemory: any,
  ): void {
    const dim = picocolors.gray;

    // Estimate total context tokens (messages + system prompt)
    // Handle both string and array (vision) content
    const allText = this.messages
      .map((m) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join(" ");
        }
        return "";
      })
      .join(" ");
    const estTokens = Math.ceil(allText.length / 4);
    const maxTokens = config.maxContextTokens;
    const pct = Math.round((estTokens / maxTokens) * 100);
    const usageBar = this.usageBar(pct);

    // Count vision images in the latest user message
    const lastMsg = this.messages[this.messages.length - 1];
    const imageCount = Array.isArray(lastMsg?.content)
      ? lastMsg.content.filter((p: any) => p.type === "image_url").length
      : 0;

    // Compact one-line manifest
    const parts: string[] = [];
    parts.push(`${memories.length} memory`);
    if (skills.length > 0) parts.push(`${skills.length} skills`);
    parts.push(`${this.registry.getAllTools().length} tools`);
    if (imageCount > 0) parts.push(`${imageCount} image${imageCount > 1 ? "s" : ""}`);
    parts.push(config.llmModelName);

    console.log(dim(`  ┌ context: ${parts.join(" · ")}`));

    // Show memory items (what the agent "remembers" about you)
    if (memories.length > 0) {
      const memNames = memories.map((m) => m.filename).join(", ");
      console.log(dim(`  │ memory: ${memNames}`));
    }

    // Show active skills (versioned procedures)
    if (skills.length > 0) {
      const skillNames = skills.map((s) => `${s.id} v${s.version}`).join(", ");
      console.log(dim(`  │ skills: ${skillNames}`));
    }

    // Show system prompt source (transparency)
    console.log(dim(`  │ prompt: skills/system-prompt/SKILL.md`));

    // Context window usage (Principle: Cost Awareness)
    const tokColor =
      pct < 60
        ? picocolors.gray
        : pct < 85
          ? picocolors.yellow
          : picocolors.red;
    console.log(
      dim(`  │ tokens: `) +
        tokColor(
          `${estTokens.toLocaleString()} / ${maxTokens.toLocaleString()} (${pct}%)`,
        ) +
        dim(` ${usageBar}`),
    );

    console.log(dim(`  └`));
  }

  /** Generate a compact progress bar for context usage. */
  private usageBar(pct: number): string {
    const width = 20;
    const filled = Math.round((pct / 100) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    return bar;
  }

  /**
   * Run a single prompt turn. This function handles the LLM response,
   * streams text content, handles tool calls, executes them, feeds them back,
   * and repeats until the model finishes calling tools.
   */
  public async prompt(
    userInput: string,
    onToken: (token: string) => void,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<void> {
    // Cloud sync: show first-run notice + ensure folder exists (once per session)
    if (!this.cloudSyncInitialized) {
      this.cloudSyncInitialized = true;
      await ensureCloudDataDir();
      if (config.outputMode === "interactive") {
        await maybeShowCloudNotice();
      }
    }

    // 1. Dynamically load Skills and Memory Context
    const memories = await this.loadMemory();
    const skills = await this.loadSkills();
    const coreMemory = await loadCoreMemory();

    // 2. Build the rich dynamic system instructions
    const systemPrompt = this.buildSystemPrompt(coreMemory, memories, skills);

    // Set or update the system prompt
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = systemPrompt;
    } else {
      this.messages.unshift({ role: "system", content: systemPrompt });
    }

    // Trim context if needed before adding new user message
    const trimmed = this.trimContextIfNeeded();
    if (trimmed > 0 && config.outputMode === "interactive") {
      console.log(
        picocolors.gray(
          `   ♻️  Trimmed ${trimmed} old messages to fit context window.`,
        ),
      );
    }

    // ── Context Manifest: show what enters the model call ──
    // Core building philosophy: transparency of context passed to the agent.
    // Before each prompt, display a compact summary of what the agent will "see."
    if (config.outputMode === "interactive") {
      this.printContextManifest(memories, skills, coreMemory);
    }

    // Append the user message — process [Image: path] markers for vision
    const processedContent = await processImageMarkers(userInput);
    this.messages.push({ role: "user", content: processedContent });
    await this.logger.logEvent("user_input", { content: userInput });

    let loopCount = 0;
    let lastAssistantContent = "";
    // Hardcoded safety net — the model decides when to stop (no tool calls = done).
    // This only catches pathological infinite loops, not normal work.
    const maxLoops = 1000;

    while (true) {
      loopCount++;
      this.tokenStats.turns++;
      await this.logger.logEvent("turn_start", {
        loop: loopCount,
        historySize: this.messages.length,
      });

      // Gather current tool definitions
      const activeTools = this.registry.getAllTools();
      const tools = activeTools.map(ToolRegistry.getOpenAIToolDefinition);

      // No loop indicator — internal plumbing, not useful to the user

      const payload: any = {
        model: config.llmModelName,
        messages: this.messages,
        temperature: 0.2,
        max_tokens: 8192, // Prevent runaway responses
      };

      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (config.llmApiKey) {
        headers["Authorization"] = `Bearer ${config.llmApiKey}`;
      }

      payload.stream = true;

      // Spinner for better UX while waiting for API response
      const spinner = new Spinner(loopCount === 1 ? "Thinking…" : "Working…");
      spinner.start();

      let response: Response;
      let retries = 0;
      const maxRetries = 3;

      while (retries <= maxRetries) {
        try {
          response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
          break;
        } catch (err: any) {
          retries++;
          if (retries > maxRetries) {
            spinner.stop();
            console.error(
              picocolors.red(
                `\n❌ Failed to connect to LLM server after ${maxRetries + 1} attempts: ${err.message}`,
              ),
            );
            await this.logger.logEvent("api_error", {
              error: err.message,
              retries,
            });
            throw err;
          }
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, retries), 8000);
          spinner.stop();
          console.log(
            picocolors.yellow(
              `   ⚠️  Connection failed (attempt ${retries}/${maxRetries}), retrying in ${delay}ms...`,
            ),
          );
          spinner.start();
          await new Promise((r) => setTimeout(r, delay));
        }
      }

      spinner.stop();

      if (!response!.ok) {
        const errorText = await response!.text();
        const msg = `LLM Server returned error (${response!.status}): ${errorText}`;
        console.error(picocolors.red(`\n❌ ${msg}`));
        await this.logger.logEvent("api_error", {
          status: response!.status,
          response: errorText,
        });
        throw new Error(msg);
      }

      const reader = response!.body?.getReader();
      if (!reader) {
        console.error(picocolors.red("\n❌ Response body is not readable."));
        return;
      }

      let assistantContent = "";
      lastAssistantContent = "";
      let accumulatedToolCalls: Record<
        number,
        { id?: string; name?: string; arguments: string }
      > = {};
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let streamDone = false;
        for (const line of lines) {
          const cleanLine = line.trim();
          if (!cleanLine || !cleanLine.startsWith("data: ")) continue;
          if (cleanLine === "data: [DONE]") {
            streamDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(cleanLine.substring(6));
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            if (delta.content) {
              assistantContent += delta.content;
              this.tokenStats.outputTokens += this.estimateTokens(
                delta.content,
              );
              onToken(delta.content);
              if (onEvent) {
                onEvent({ type: "token", data: { text: delta.content } });
              }
            }

            if (delta.tool_calls) {
              for (const tcDelta of delta.tool_calls) {
                const index = tcDelta.index;
                if (index === undefined) continue;

                if (!accumulatedToolCalls[index]) {
                  accumulatedToolCalls[index] = { arguments: "" };
                }

                if (tcDelta.id) {
                  accumulatedToolCalls[index].id = tcDelta.id;
                }
                if (tcDelta.function?.name) {
                  accumulatedToolCalls[index].name = tcDelta.function.name;
                }
                if (tcDelta.function?.arguments) {
                  accumulatedToolCalls[index].arguments +=
                    tcDelta.function.arguments;
                }
              }
            }
          } catch (e) {
            // Ignore incomplete line parse failures
          }
        }
        if (streamDone) break;
      }

      const toolCalls: ToolCall[] = Object.keys(accumulatedToolCalls).map(
        (key) => {
          const idx = parseInt(key, 10);
          const raw = accumulatedToolCalls[idx];
          return {
            id: raw.id || `call_${Date.now()}_${idx}`,
            type: "function",
            function: {
              name: raw.name || "",
              arguments: raw.arguments || "{}",
            },
          };
        },
      );

      const assistantMsg: Message = {
        role: "assistant",
        content: assistantContent || "",
      };

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }

      this.messages.push(assistantMsg);
      await this.logger.logEvent("assistant_response", assistantMsg);

      lastAssistantContent = assistantContent;

      if (toolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      if (config.outputMode === "interactive") console.log("");

      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const toolName = call.function.name;
        const displayName = Agent.getToolDisplayName(toolName);
        let args: any = {};
        try {
          let rawArgs = call.function.arguments.trim();
          // Strip triple backticks wrapper or json identifier if present
          if (rawArgs.startsWith("```")) {
            rawArgs = rawArgs
              .replace(/^```(?:json)?\n?/i, "")
              .replace(/\n?```$/, "")
              .trim();
          }
          args = JSON.parse(rawArgs);
        } catch (e) {
          // Args parsing failed — will show raw
        }

        // Emit tool_call event for GUI
        if (onEvent) {
          onEvent({ type: "tool_call", data: { toolName, toolArgs: args } });
        }

        // Human-Approval Gate Check (centralized in agent, not duplicated in tools)
        let isApproved = true;
        if (config.dryRun) {
          isApproved = true;
        } else if (config.requireApprovalFor.includes(toolName)) {
          // Emit approval event for GUI
          if (onEvent) {
            onEvent({
              type: "approval",
              data: { toolName, toolArgs: args },
            });
          }
          isApproved = await askUserApproval(
            toolName,
            args,
            this.sessionReadline ?? undefined,
          );
        }

        let result: any;
        if (config.dryRun) {
          result = `[DRY RUN] Would execute '${toolName}' with: ${JSON.stringify(args)}`;
          if (config.outputMode === "interactive") {
            statusLine("DRY", `Preview — ${displayName}`);
            console.log(formatDetails(toolName, args, theme().gray("  ")));
          }
        } else if (!isApproved) {
          result = `Error: Action '${toolName}' was denied by the user.`;
          console.log(picocolors.red(`  ✗ ${displayName} — declined by you`));
        } else {
          const keyArg = this.summarizeToolArgs(toolName, args);
          const argHint = keyArg ? picocolors.gray(` ${keyArg}`) : "";

          // ── Destructive Action Guard (Principle: Read Before Write) ──
          // Enforce that write_file and replace_content cannot run on a file
          // that was never read in the current session.
          const resolvedPath = args.filePath ? path.resolve(args.filePath) : "";
          const fileExists = resolvedPath ? fsSync.existsSync(resolvedPath) : false;

          if (
            (toolName === "write_file" || toolName === "replace_content") &&
            resolvedPath &&
            fileExists &&
            !this.filesReadThisSession.has(resolvedPath)
          ) {
            result = `Error: Refusing to ${toolName === "write_file" ? "write to" : "edit"} '${args.filePath}' \u2014 this file was not read first. Always use view_file to read a file before modifying it. This is a safety guard to prevent blind edits.`;
            if (config.outputMode === "interactive") {
              process.stdout.write(
                `\r  ${picocolors.red("✗")} ${picocolors.gray(displayName)}${argHint} \u2014 not read first\n`,
              );
            }
          } else {
            if (config.outputMode === "interactive") {
              process.stdout.write(
                `  ⟳ ${picocolors.cyan(displayName)}${argHint}…`,
              );
            }
            const tool = this.registry.getTool(toolName);
            if (!tool) {
              result = `Error: Action '${toolName}' is not available.`;
              if (config.outputMode === "interactive") {
                process.stdout.write(
                  `\r  ${picocolors.red("✗")} ${picocolors.gray(displayName)} — not found\n`,
                );
              }
            } else {
              try {
                result = await tool.execute(args);
                this.tokenStats.toolCalls++;

                // Track files read for read-before-write enforcement
                if (toolName === "view_file" && args.filePath) {
                  this.filesReadThisSession.add(path.resolve(args.filePath));
                }

                if (config.outputMode === "interactive") {
                  process.stdout.write(
                    `\r  ${picocolors.green("✓")} ${picocolors.gray(displayName)}${argHint}\n`,
                  );
                  // ── Result Preview (Principle: Result Visibility) ──
                  // Show a truncated preview of what the tool returned
                  const preview = this.summarizeResult(result);
                  if (preview) {
                    console.log(picocolors.gray(`    → ${preview}`));
                  }
                }
              } catch (error: any) {
                result = `Error performing action: ${error.message}`;
                if (config.outputMode === "interactive") {
                  process.stdout.write(
                    `\r  ${picocolors.red("✗")} ${picocolors.gray(displayName)} — ${picocolors.red(error.message.slice(0, 60))}\n`,
                  );
                }
              }
            }
          } // end destructive action guard
        }

        const toolMsg: Message = {
          role: "tool",
          content: typeof result === "string" ? result : JSON.stringify(result),
          name: toolName,
          tool_call_id: call.id,
        };

        this.messages.push(toolMsg);
        this.tokenStats.inputTokens += this.estimateTokens(
          (toolMsg.content as string) || "",
        );
        await this.logger.logEvent("tool_result", {
          tool: toolName,
          callId: call.id,
          result,
        });

        // Emit tool_result event for GUI
        if (onEvent) {
          onEvent({
            type: "tool_result",
            data: {
              toolName,
              toolResult:
                typeof result === "string" ? result : JSON.stringify(result),
            },
          });
        }
      }

      if (config.outputMode === "interactive") {
        console.log("");
      }
    }

    if (loopCount >= maxLoops) {
      if (config.outputMode !== "json") {
        console.warn(
          picocolors.yellow(
            `\n⚠️  Safety limit reached (${maxLoops} iterations). The model did not stop on its own.`,
          ),
        );
      }
    }

    // Auto-save session state after each prompt completes (sync for reliability)
    this.saveSessionStateSync();

    // Auto-sync to cloud folder (silent, fire-and-forget)
    autoSyncToCloud();

    // Emit done event for GUI
    if (onEvent) {
      onEvent({
        type: "done",
        data: {
          response: lastAssistantContent || "",
          tokenStats: this.tokenStats,
        },
      });
    }
  }
}
