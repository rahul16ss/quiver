import { promises as fs } from "fs";
import * as path from "path";
import picocolors from "picocolors";
import readline from "readline";
import { config } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { loadCoreMemory } from "./state.js";
import { statusLine, theme } from "./cli_ui.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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
  private dirEnsured = false;

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.logPath = path.resolve(".sessions", `${this.sessionId}.jsonl`);
  }

  public async logEvent(type: string, data: any): Promise<void> {
    if (!config.sessionLogEnabled) return;

    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type,
      data: sanitizeLogData(type, data),
    })}\n`;

    try {
      if (!this.dirEnsured) {
        await fs.mkdir(path.dirname(this.logPath), { recursive: true });
        this.dirEnsured = true;
      }
      await fs.appendFile(this.logPath, line, "utf8");
    } catch {
      // Fail silently for logger writes
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionLogPath(): string {
    return this.logPath;
  }

  public getSessionLogRelPath(): string {
    return `.sessions/${this.sessionId}.jsonl`;
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
  console.log(
    picocolors.yellow(`\n┌── 🔒 Security Permission Request ${"─".repeat(15)}`),
  );
  console.log(
    picocolors.yellow(
      `│  The AI is requesting permission to perform an action on your system:`,
    ),
  );
  console.log(picocolors.yellow(`│  `));
  console.log(
    picocolors.yellow(`│  Action Name: `) + picocolors.green(toolName),
  );
  console.log(picocolors.yellow(`│  Details:`));
  console.log(formatDetails(toolName, args, picocolors.yellow(`│    `)));
  console.log(
    picocolors.yellow(
      `└───────────────────────────────────────────────────────────`,
    ),
  );

  const prompt = picocolors.bold(picocolors.cyan("Allow this action? (y/N): "));

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
      const fsSync = require("fs");
      const pathSync = require("path");
      fsSync.mkdirSync(pathSync.dirname(statePath), { recursive: true });
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
  }

  /**
   * Returns a deep copy of messages with secrets redacted from tool results
   * and content. Used for safe persistence to disk.
   */
  private getRedactedMessages(): Message[] {
    return this.messages.map((msg) => {
      const redacted: Message = {
        role: msg.role,
        content: msg.content ? redactSecrets(msg.content) : msg.content,
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
    const recentMessages = this.messages.slice(-keepLast);
    const removedCount = this.messages.length - keepLast - (systemMsg ? 1 : 0);

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
   * Separated so it can be reused when model changes at runtime.
   */
  private buildSystemPrompt(
    coreMemory: any,
    memories: any[],
    skills: any[],
  ): string {
    let systemPrompt = `You are Quiver, an elite autonomous coding and research assistant running in a terminal-based CLI.
You are powered by model ${config.llmModelName} and have access to file operations, browser automation, shell command execution, web search, and more.

--- Core Principles ---
1. READ BEFORE WRITE: Always use view_file to read a file before modifying it. Never guess at file contents.
2. MINIMAL EDITS: Prefer replace_content for targeted edits over write_file for full rewrites. Only rewrite entire files when creating new files or when the file is small enough to rewrite safely.
3. VERIFY AFTER CHANGES: After making code changes, run run_tests to validate. Fix any compilation or test failures before declaring success.
4. EXPLORE FIRST: Use list_dir and view_file to understand project structure before making changes. Don't assume file layouts.
5. NO HALLUCINATION: Never fabricate file paths, function names, or APIs. If unsure, read the file or search the codebase first.
6. ERROR RECOVERY: When a tool fails, analyze the error, adjust your approach, and retry. Don't give up after a single failure.
7. PROGRESSIVE DISCLOSURE: Work incrementally — make a change, verify it, then move to the next step. Don't batch risky operations.

--- Operational Style ---
You operate as an autonomous coding agent, similar to Codex or Claude Code.
- Prefer making reasonable assumptions over asking clarifying questions.
- Continue using tools to make progress until the task is complete, then present a summary.
- At decision points, choose the most sensible option and keep working.
- If something fails, try an alternative approach before reporting the issue.
- When the work is fully done, respond with a concise summary of what was accomplished.
- Be concise in your text responses. Let tool calls do the work. Don't narrate every step.

--- Workflow ---
- You can create new tools at runtime using the 'create_tool' action when you need capabilities that don't exist yet.
- Follow a Plan → Implement → Validate cycle: outline changes first, write clean TypeScript, then run 'run_tests' to verify.
- If tests or compilation fail, fix the issues before proceeding.
- Use grep_search to find usages, view_file to read code, replace_content for surgical edits.
- Use format_code after writing new TypeScript files to maintain consistent style.

--- Code Style ---
- Use TypeScript with proper types (avoid 'any' where possible).
- 2-space indentation, semicolons, trailing commas in multiline objects.
- Descriptive variable names. Prefer clarity over brevity.
- Handle errors gracefully with try/catch and meaningful error messages.
- Keep functions focused and small. Single responsibility.

Be concise, clear, and direct. Use tools logically to solve the task at hand.`;

    // Quiver Core Memory blocks integration
    systemPrompt += `\n\n--- CORE MEMORY BLOCKS ---
[Identity]: ${coreMemory.identity}
[Human Context]: ${coreMemory.human_context}
[Project Context]: ${coreMemory.project_context}\n`;

    if (memories.length > 0) {
      systemPrompt += `\n--- ACTIVE PERSISTENT MEMORY ---\n`;
      for (const m of memories) {
        systemPrompt += `[Memory Snippet: ${m.filename}]\n${m.content}\n\n`;
      }
    }

    if (skills.length > 0) {
      systemPrompt += `\n--- ACTIVE TASK PROCEDURES (SKILLS) ---\n`;
      for (const s of skills) {
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
      if (msg.content) totalTokens += this.estimateTokens(msg.content);
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
    const keptNonSystem = nonSystemMessages.slice(-keepRecent);
    const removedCount = nonSystemMessages.length - keptNonSystem.length;

    this.messages = [...systemMessages, ...keptNonSystem];
    return removedCount;
  }

  /**
   * Run a single prompt turn. This function handles the LLM response,
   * streams text content, handles tool calls, executes them, feeds them back,
   * and repeats until the model finishes calling tools.
   */
  public async prompt(
    userInput: string,
    onToken: (token: string) => void,
  ): Promise<void> {
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

    // Append the user message
    this.messages.push({ role: "user", content: userInput });
    await this.logger.logEvent("user_input", { content: userInput });

    let loopCount = 0;
    const maxLoops = config.maxLoops;

    while (loopCount < maxLoops) {
      loopCount++;
      this.tokenStats.turns++;
      await this.logger.logEvent("turn_start", {
        loop: loopCount,
        historySize: this.messages.length,
      });

      // Gather current tool definitions
      const activeTools = this.registry.getAllTools();
      const tools = activeTools.map(ToolRegistry.getOpenAIToolDefinition);

      // Show compact loop indicator (after first loop)
      if (config.outputMode === "interactive" && loopCount > 1) {
        console.log(
          picocolors.gray(
            `   ↻ Loop ${loopCount} · ${activeTools.length} tools · ${config.llmModelName}`,
          ),
        );
      }

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
      const spinner = new Spinner(
        loopCount === 1 ? "Thinking..." : `Processing (loop ${loopCount})...`,
      );
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
        content: assistantContent || null,
      };

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }

      this.messages.push(assistantMsg);
      await this.logger.logEvent("assistant_response", assistantMsg);

      if (toolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      if (config.outputMode === "interactive")
        console.log(
          picocolors.cyan(
            `\n╭─── 🛠️  Performing ${toolCalls.length} action(s) `,
          ) + picocolors.cyan("─".repeat(22)),
        );
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const toolName = call.function.name;
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
          console.error(
            picocolors.yellow(
              `│  ⚠️  Failed to parse details for action ${toolName}`,
            ),
          );
        }

        // Human-Approval Gate Check (centralized in agent, not duplicated in tools)
        let isApproved = true;
        if (config.dryRun) {
          isApproved = true;
        } else if (config.requireApprovalFor.includes(toolName)) {
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
            statusLine("DRY", `Preview only — ${toolName}`);
            console.log(formatDetails(toolName, args, theme().gray("  ")));
          }
        } else if (!isApproved) {
          result = `Error: Action '${toolName}' was denied by the user.`;
          console.log(
            picocolors.red(
              `│  🚫 Declined: Action "${toolName}" was blocked by user.`,
            ),
          );
        } else {
          if (config.outputMode === "interactive") {
            console.log(
              picocolors.cyan(`│  🚀 Action:  `) + picocolors.green(toolName),
            );
            console.log(picocolors.cyan(`│  👉 Details: `));
            console.log(
              formatDetails(toolName, args, picocolors.gray(`│    `)),
            );
          }
          const tool = this.registry.getTool(toolName);
          if (!tool) {
            result = `Error: Action '${toolName}' is not available.`;
            console.error(picocolors.red(`│  ❌ Error: ${result}`));
          } else {
            try {
              result = await tool.execute(args);
              this.tokenStats.toolCalls++;
              if (config.outputMode === "interactive") {
                const displayResult =
                  typeof result === "string" ? result : JSON.stringify(result);
                const preview =
                  displayResult.length > 300
                    ? `${displayResult.substring(0, 300)}... (truncated)`
                    : displayResult;
                console.log(
                  picocolors.cyan(`│  ✅ Outcome: `) +
                    picocolors.magenta(
                      preview.replace(/\n/g, "\n│              "),
                    ),
                );
              }
            } catch (error: any) {
              result = `Error performing action: ${error.message}`;
              console.error(picocolors.red(`│  ❌ Failed:  ${error.message}`));
            }
          }
        }

        if (i < toolCalls.length - 1 && config.outputMode === "interactive") {
          console.log(picocolors.cyan(`├${"─".repeat(46)}`));
        }

        const toolMsg: Message = {
          role: "tool",
          content: typeof result === "string" ? result : JSON.stringify(result),
          name: toolName,
          tool_call_id: call.id,
        };

        this.messages.push(toolMsg);
        this.tokenStats.inputTokens += this.estimateTokens(
          toolMsg.content || "",
        );
        await this.logger.logEvent("tool_result", {
          tool: toolName,
          callId: call.id,
          result,
        });
      }
      if (config.outputMode === "interactive") {
        console.log(
          picocolors.cyan(`╰──────────────────────────────────────────────╯`),
        );
      }
    }

    if (loopCount >= maxLoops) {
      if (config.outputMode !== "json") {
        console.warn(
          picocolors.yellow(
            `⚠️  Reached max loop iterations (${maxLoops}) to prevent runaways.`,
          ),
        );
      }
    }

    // Auto-save session state after each prompt completes (sync for reliability)
    this.saveSessionStateSync();
  }
}
