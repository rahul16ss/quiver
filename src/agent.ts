import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import picocolors from "picocolors";
import { config, needsApprovalFor } from "./config.js";
import { processFileMarkers } from "./file_encoder.js";
import { ToolRegistry } from "./registry.js";
import { mcpManager } from "./mcp/client.js";
import { loadCoreMemory } from "./state.js";
import { statusLine, theme, renderInlineDiff } from "./cli_ui.js";
import { generateUnifiedDiff, generateFileCreationDiff, isRiskyFile } from "./diff.js";
import {
  compactWithSummarization,
  proposeCompaction,
  applyCompaction,
  offloadLargeToolResults,
  needsCompaction,
  calculateKeepRecent,
} from "./context_manager.js";
import { loadReviewedMemoryContext, assemblePrompt } from "./prompt/assembler.js";
import { classifyCommand } from "./security/command_policy.js";
import {
  mergeToolCallPassthrough,
  shapeOutboundToolCall,
  toolCallHasPassthrough,
  type ToolCallPassthrough,
} from "./providers/tool_call_passthrough.js";
import { InterventionController } from "./intervention.js";
import { ApprovalCache, type ApprovalKey, type ApprovalScope } from "./security/approval_cache.js";
import { GoalLoopEngine } from "./ambient.js";
import { loadExampleContext, listExamples } from "./memory/examples_store.js";
import { SECURITY_PREAMBLE } from "./prompts/security.js";
import { FileReadHistory } from "./session/file_access.js";
import { getActiveProvider } from "./providers/index.js";
import { getAdapterForModel, type HarnessAdapter } from "./adapters/index.js";
import { type ModelInfo } from "./providers/index.js";
import { calculateBudget, shouldBlockSubmission } from "./context/budget.js";
import {
  lifecycleRegistry,
  registerBuiltinHooks,
  wrapModelCall,
  wrapToolCall,
  type LifecycleContext,
} from "./lifecycle.js";
import {
  ConsecutiveFailureTracker,
  createDiagnosticBlock,
  formatDiagnosticBlock,
} from "./diagnostics.js";

import {
  validateCitations as validateCitationsImport,
  updateUsageStats,
  getAllUsageStats as getAllUsageStatsImport,
} from "./memory/citation_parser.js";
import { getDefaultDecayConfig, getArchivalCandidates } from "./memory/decay.js";
import { redactSecrets } from "./security/secrets.js";
import { atomicWrite, atomicWriteSync, CorruptStateError } from "./fs/atomic_write.js";
import { EvidenceTracker } from "./evidence/tracker.js";
import { withEvidenceTracker } from "./tools/evidence.js";
import { CheckpointManager } from "./session/checkpoint.js";
import { calculateBackoffWithJitter } from "./logger.js";
import { AuditChain, type AuditEntry } from "./audit_chain.js";
import {
  getProjectMemoryDir,
  getSkillsDir,
  getProjectSessionsDir,
  getProjectName,
  getProjectId,
} from "./paths.js";

// ─── Vision: Image encoding ───────────────────────────────────────────
// Detects [File: path] markers in user input, validates the file is a
// real image (by magic bytes, not just extension), reads it, and encodes
// as base64 data URL for the OpenAI-compatible vision API.
// Security: only local files, no path traversal, size-limited, magic-byte validated.

// ─── US-6.3: Auto-retry is gated by an explicit retry-safe/idempotent ──
// predicate. Destructive/shell/state-mutating tools are NEVER auto-retried;
// only read-only, idempotent tools may be retried on transient failure.
const RETRY_SAFE_TOOLS = new Set([
  "view_file",
  "list_dir",
  "grep",
  "find",
  "web_search",
  "scrape_url",
  "deep_research",
  "find_all",
  "entity_search",
]);

/**
 * Truncate a tool arg hint (file path, URL, command…) to the terminal width
 * with middle elision so the trailing filename / extension stays visible.
 * Width-aware so long paths never blow out the tool-call line or leave stray
 * characters after an in-place status rewrite. Falls back to 60 cols when the
 * terminal width is unknown (non-TTY / CI).
 */
function truncateForDisplay(val: string): string {
  const cols =
    (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80) - 2; // small right margin
  const max = Math.min(60, Math.max(24, cols));
  if (val.length <= max) return val;
  // Keep the last ~40% (filename/ext) and the first ~60% (dir context).
  const tailLen = Math.max(10, Math.floor(max * 0.4));
  const headLen = max - tailLen - 1; // 1 char for the ellipsis
  return `${val.substring(0, headLen)}…${val.substring(val.length - tailLen)}`;
}

/** A tool is retry-safe only if it is read-only and idempotent (US-6.3). */
function isRetrySafe(toolName: string): boolean {
  return RETRY_SAFE_TOOLS.has(toolName);
}

/**
 * UX: classify a model-call error into an honest, human label so the retry
 * line and the final-failure line tell the user what actually happened —
 * instead of the old blanket "Connection failed"/"Failed to connect to LLM
 * server" that was wrong for request rejections (4xx/5xx) and auth failures.
 * Order matters: most-specific first.
 */
function classifyModelError(msg: string): string {
  const m = msg || "";
  if (/gcloud|reauth|invalid_grant|invalid_rapt|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(m))
    return "Google Cloud session expired — run 'gcloud auth application-default login'";
  if (/Provider error 401|invalid.*api.*key|unauthor|Missing Authentication header/i.test(m))
    return "Auth failed — check the model key (OPENROUTER_API_KEY for cloud, LLM_API_KEY for local). Settings → model key, or the OS credential store.";
  if (/429|RESOURCE_EXHAUSTED|resource exhausted|rate.?limit/i.test(m))
    return "Model provider is rate-limiting — wait a moment and try again";
  if (/thought_signature|INVALID_ARGUMENT|invalid argument/i.test(m))
    return "Provider rejected tool history — repairing and retrying";
  if (/Provider error 40[0-9]/.test(m)) return "Request rejected by provider (HTTP 4xx)";
  if (/Provider error 4\d\d/.test(m)) return "Request rejected by provider (HTTP 4xx)";
  if (/Provider error 5\d\d/.test(m)) return "Provider error (HTTP 5xx)";
  if (/Connection timeout|Stream stall timeout/.test(m)) return "Timed out waiting for model";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up/i.test(m))
    return "Connection failed";
  if (/aborted|cancel/i.test(m)) return "Request cancelled";
  return "Model call failed";
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | null
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
        | { type: "file"; file: { filename: string; file_data: string } }
      >;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** Events emitted during prompt execution for GUI consumption. */
export interface AgentEvent {
  type:
    | "token"
    | "tool_call"
    | "tool_result"
    | "approval"
    | "done"
    | "error"
    | "context_manifest"
    | "intervention"
    | "consent_gate"
    | "consent_declined"
    | "consent_exclude"
    | "sensitivity_refused"
    | "compaction_proposed"
    | "evidence_consent_proposed";
  data: {
    text?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
    approved?: boolean;
    response?: string;
    error?: string;
    model?: string;
    memory?: string;
    skills?: string;
    /** Structured loaded-skill list for the GUI context rail (id + version). */
    skillsDetail?: { id: string; version: string }[];
    tools?: string;
    /** Tool catalog names for the GUI context rail (spec §6 layer C). */
    toolNames?: string[];
    tokens?: string;
    tokenStats?: {
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      turns: number;
    };
    /** Consent gate (SPEC §6): the decision the user made. */
    action?: "approve" | "decline" | "exclude";
    consent?: string;
    /** Sensitivity routing (US-17.17): a high-sensitivity turn was refused. */
    reason?: string;
    refused?: boolean;
    /** Compaction consent (SPEC §7.3): a compaction is proposed, awaiting approval. */
    removedCount?: number;
    keptRecent?: number;
    tokensBefore?: number;
    tokensAfter?: number;
    savedTo?: string;
    summary?: string;
    /** Episodic examples (SPEC §7.4): count of promoted examples loaded. */
    examples?: string;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
  /**
   * Opaque provider fields captured from the wire and echoed later.
   * Prefer this over inventing vendor-specific product paths.
   */
  passthrough?: Record<string, unknown>;
  /**
   * Legacy storage shape (sessions saved before passthrough). Still echoed.
   * @deprecated use passthrough
   */
  extra_content?: Record<string, unknown>;
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

/** Safe JSON.stringify that handles circular references without throwing. */
function safeStringify(obj: any): string {
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
      const resultStr = typeof result === "string" ? result : safeStringify(result ?? "");
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
  // Tamper-evident audit chain (SPEC §11.3 / US-9.5). Persisted to
  // `<sessionId>_audit.json` so a reviewer can replay the build and verify
  // integrity. Provenance (SPEC §16) is embedded in the hashed payload.
  private auditChain: AuditChain;
  private auditLogPath: string;

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.logPath = path.join(getProjectSessionsDir(), `${this.sessionId}.json`);
    this.auditLogPath = path.join(getProjectSessionsDir(), `${this.sessionId}_audit.json`);
    this.auditChain = new AuditChain();
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

  /**
   * Log evidence/provenance for a deliverable (SPEC §16 / §11.3 / §7.5).
   * Records what context and sources produced a draft — embedded in the
   * tamper-evident audit chain's hashed payload. The convenience fields are
   * derived from the payload so verifyChain() detects after-the-fact edits.
   */
  public logEvidenceProvenance(entry: {
    deliverablePath: string;
    sourceIds: string[];
    sourceRefs: string[];
    contextUsed: string;
    evidenceRef?: string;
  }): void {
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
    // Derive convenience fields from the (redacted) payload the chain hashed.
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

    this.logEvent("evidence_provenance", {
      deliverable: entry.deliverablePath,
      source_ids: entry.sourceIds,
      source_refs: entry.sourceRefs,
      context_used: entry.contextUsed,
      evidence_ref: entry.evidenceRef,
      provenance,
    });
  }

  /**
   * Log a consent-gate decision to the tamper-evident audit chain (SPEC §6 —
   * "a gate, not a post-hoc log"). The approve/decline/exclude decision is
   * recorded so a reviewer can see the user explicitly approved the context
   * that entered the model.
   */
  public logConsentDecision(decision: {
    action: "approve" | "decline" | "exclude";
    model?: string;
    memoryCount?: number;
    skillsCount?: number;
    toolCount?: number;
  }): void {
    const payload = safeStringify({
      consent_decision: decision.action,
      model: decision.model,
      memory_count: decision.memoryCount,
      skills_count: decision.skillsCount,
      tool_count: decision.toolCount,
    });
    this.auditChain.appendEntry("approval", payload);
    this.logEvent("consent_decision", decision);
  }

  /** Verify the tamper-evident audit chain (SPEC §11.3). */
  public verifyAuditChain(): boolean {
    return this.auditChain.verifyChain();
  }

  /** Get the audit chain entries (for the evidence package / reproducibility). */
  public getAuditEntries(): AuditEntry[] {
    return this.auditChain.getEntries();
  }

  /** Write accumulated logs to disk once. Call at session end or on error. */
  public async flush(): Promise<void> {
    try {
      if (!this.dirEnsured) {
        await fs.mkdir(path.dirname(this.logPath), { recursive: true });
        this.dirEnsured = true;
      }
    } catch {
      // Fail silently — logging must never crash the agent
    }
    if (this.logs.length > 0) {
      try {
        await atomicWrite(this.logPath, JSON.stringify(this.logs, null, 2));
      } catch {
        // Fail silently — logging must never crash the agent
      }
    }
    // Tamper-evident audit chain
    try {
      await atomicWrite(this.auditLogPath, this.auditChain.serialize());
    } catch {
      // Fail silently — logging must never crash the agent
    }
  }

  /** Synchronous flush for use in exit handlers and SIGINT/SIGTERM contexts. */
  public flushSync(): void {
    try {
      fsSync.mkdirSync(path.dirname(this.logPath), { recursive: true });
    } catch {
      // Fail silently
    }
    if (this.logs.length > 0) {
      try {
        atomicWriteSync(this.logPath, JSON.stringify(this.logs, null, 2));
      } catch {
        // Fail silently — logging must never crash the agent
      }
    }
    try {
      atomicWriteSync(this.auditLogPath, this.auditChain.serialize());
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

  /** Expose the accumulated log events for session-trace memory extraction. */
  public getLogs(): any[] {
    return this.logs;
  }
}

// Helper to format arguments/details beautifully, folding large text blocks (like raw code)
function formatDetails(toolName: string, args: any, prefix: string): string {
  if (typeof args !== "object" || args === null) {
    return `${prefix}${JSON.stringify(args)}`;
  }

  const cloned = { ...args };
  const foldFields = ["content", "replacementContent", "code", "text", "replacement"];
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

// Approval gate prompt — uses the shared askQuestionRaw utility for consistent
// input experience across all prompts.
async function askUserApproval(
  toolName: string,
  args: any,
): Promise<{
  approved: boolean;
  revisionNote?: string;
  scope?: ApprovalScope;
}> {
  const displayName = Agent.getToolDisplayName(toolName);

  // Detect irreversible actions for stronger warning (Principle: Reversibility Awareness)
  const irreversible = isIrreversibleAction(toolName, args);

  // ── Inline diff preview for file-mutation tools (Principle: Seeing) ──
  // Show the exact change before asking for consent, so the user reviews real
  // +/- lines in the terminal (parity with the GUI diff) rather than a bare
  // arg blob. Purely additive display; never alters the y/N consent flow.
  if (config.outputMode === "interactive") {
    try {
      const rel = (fp: string) => {
        try {
          return path.relative(process.cwd(), path.resolve(fp));
        } catch {
          return fp;
        }
      };
      let diffText: string | null = null;
      if (toolName === "write_file" && typeof args.filePath === "string") {
        const fp = path.resolve(args.filePath);
        if (fsSync.existsSync(fp)) {
          const old = fsSync.readFileSync(fp, "utf8");
          diffText = generateUnifiedDiff(old, String(args.content ?? ""), rel(args.filePath));
        } else {
          diffText = generateFileCreationDiff(rel(args.filePath), String(args.content ?? ""));
        }
      } else if (toolName === "replace_content" && typeof args.filePath === "string") {
        const fp = path.resolve(args.filePath);
        if (fsSync.existsSync(fp)) {
          const old = fsSync.readFileSync(fp, "utf8");
          const next = old.split(args.targetContent ?? "").join(args.replacementContent ?? "");
          diffText = generateUnifiedDiff(old, next, rel(args.filePath));
        }
      } else if (toolName === "apply_patch" && typeof args.patch === "string") {
        // The patch is itself a unified diff — colorize it directly.
        diffText = String(args.patch);
      }
      if (diffText) {
        const t = theme();
        const header = isRiskyFile(String(args.filePath ?? ""))
          ? t.danger("  risky file (lockfile/CI/config) — review carefully")
          : "";
        if (header) console.log(header);
        console.log(
          renderInlineDiff(diffText)
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n"),
        );
      }
    } catch {
      // Diff preview must never block or break the approval gate.
    }
  }

  // In JSON mode, the approval UI is rendered by the GUI via the "approval" event.
  // Suppress the text-based permission box to avoid non-JSON output on stdout.
  if (config.outputMode === "interactive") {
    const { card, warn } = await import("./cli_ui.js");
    if (irreversible) {
      warn("This action cannot be undone.");
    }
    card({
      title: `Quiver wants to: ${displayName}`,
      body: formatDetails(toolName, args, "")
        .split("\n")
        .filter((l: string) => l.trim().length > 0),
      footer: "Review the change above, then choose below.",
      accent: "brand",
    });
  }

  const prompt = irreversible
    ? picocolors.bold(picocolors.red("  Confirm? (y/N): "))
    : picocolors.bold(picocolors.cyan("  Allow? (y = yes / a = all similar / N = no): "));

  // All prompts — main input, approvals, confirmations — go through the
  // same shared askQuestionRaw utility, which uses the multiline editor.
  const { askQuestionRaw } = await import("./utils/prompt.js");
  const answer = await askQuestionRaw(prompt);
  const cleanAnswer = answer.trim().toLowerCase();
  if (cleanAnswer === "a" || cleanAnswer === "all") {
    return { approved: true, scope: "session" as const };
  }
  const approved = cleanAnswer === "y" || cleanAnswer === "yes";
  if (approved) {
    return { approved: true, scope: "once" as const };
  }
  const note = await askQuestionRaw(
    picocolors.gray("  Revision note (optional, press Enter to deny): "),
  );
  return { approved: false, revisionNote: note.trim() || undefined };
}

/** Detect irreversible actions that warrant a stronger warning. */
function isIrreversibleAction(toolName: string, args: any): boolean {
  if (toolName === "run_command" && args?.command) {
    // H6: use the hardened command classifier (command_policy.ts), which
    // normalizes bash quote obfuscation (r""m, r'm', $'rm') BEFORE pattern
    // matching. The old raw-regex check missed `r""m -rf /` — the exact
    // bypass the command classifier was built to close — so a destructive
    // command got only the weak warning. Destructive/privileged commands are
    // irreversible for warning purposes.
    try {
      const { risk } = classifyCommand(String(args.command));
      if (risk === "destructive" || risk === "privileged") return true;
    } catch {
      // classifier unavailable — fall through to the raw-regex guard below
    }
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

// Animated spinner for streaming UX. Shows a rotating braille frame +
// elapsed seconds so a long think/tool run is visibly alive instead of a
// frozen line (the 5-star "is it stuck?" feedback). Previously this was a
// no-op that printed a static "Thinking…" and looked frozen for the whole
// think duration — which read as a hang to the user.
//
// Safety contract (why this can't reintroduce the old "missing first
// letters" bug):
//  - start() is a no-op outside interactive TTY mode (piped/scripted runs
//    stay raw & machine-readable).
//  - The agent calls spinner.stop() on the FIRST streamed token (see
//    STREAMING-NO-SPINNER-CLOBBER), so the repaint loop is already halted
//    before any assistant text reaches stdout — it can never overwrite
//    streamed content.
//  - stop() clears the interval and wipes the exact width it wrote, so no
//  - stray characters / cursor artifacts are left behind.
//  - Every interval callback is guarded; a throw inside the repaint can never
//    crash the agent loop.
//  - We never write a trailing newline, so the next output (streamed token or
//    status line) starts cleanly at column 0 after stop() clears the line.
// Spinner — braille frames via setInterval with elapsed seconds and a
// max-width wipe on stop() so streamed tokens never get clobbered by a stale
// spinner frame. The acceptance contract (US-2.2) requires setInterval +
// FRAMES + elapsed + clearInterval + maxWidth wipe; keep those intact.
class Spinner {
  private message: string;
  private active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startMs = 0;
  private frameIdx = 0;
  private maxWidth = 0;
  private static readonly FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  constructor(message: string) {
    this.message = message;
  }

  private render(): void {
    try {
      const elapsed = Math.floor((Date.now() - this.startMs) / 1000);
      const frame = Spinner.FRAMES[this.frameIdx % Spinner.FRAMES.length];
      this.frameIdx++;
      // Animated block progress bar (opencode-style): 8 blocks that sweep
      // left-to-right then right-to-left (ping-pong), ~6s per direction.
      const barWidth = 8;
      const loopSec = 6;
      const stepsPerLoop = Math.round((loopSec * 1000) / 120);
      const step = this.frameIdx % (stepsPerLoop * 2);
      const phase =
        step < stepsPerLoop
          ? step / stepsPerLoop // left → right
          : (stepsPerLoop * 2 - step) / stepsPerLoop; // right → left
      const filled = Math.round(phase * barWidth);
      const bar = "■".repeat(filled) + "⬝".repeat(barWidth - filled);
      const line = `  ${picocolors.cyan(frame)} ${picocolors.gray(this.message)} ${picocolors.gray(`${elapsed}s`)} ${picocolors.cyan(bar)}`;
      const visibleLen = `  ${frame} ${this.message} ${elapsed}s ${bar}`.length;
      if (visibleLen > this.maxWidth) this.maxWidth = visibleLen;
      process.stdout.write("\r" + line);
    } catch {
      // Rendering must never crash the agent loop.
    }
  }

  start(): void {
    if (this.active || config.outputMode !== "interactive") return;
    if (!process.stdout.isTTY) return;
    this.active = true;
    this.startMs = Date.now();
    this.frameIdx = 0;
    this.maxWidth = 0;
    this.render();
    this.timer = setInterval(() => this.render(), 120);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      const pad = Math.max(this.maxWidth, this.message.length + 6);
      process.stdout.write("\r" + " ".repeat(pad) + "\r");
    } catch {
      // ignore
    }
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
  // Per-engagement spend attribution: the chat plane records into the SAME
  // cost ledger the workflow plane uses (~/.quiver/cost-ledger.jsonl), so
  // engagement spend is one number, not "workflows only". Lazy so tests and
  // air-gapped runs never pay for it unless a turn actually completes.
  private costLedger: import("./harness/cost-ledger.js").CostLedger | null = null;

  private recordChatUsage(
    usage: { promptTokens: number; completionTokens: number; costUsd?: number },
    modelName: string,
  ): void {
    const entry = {
      at: new Date().toISOString(),
      engagementId: `chat:${path.basename(process.cwd())}`,
      kind: "model" as const,
      role: "maker",
      profileSlug: modelName,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usage.costUsd ?? 0,
    };
    try {
      if (this.costLedger) {
        this.costLedger.record(entry);
        return;
      }
      void import("./harness/cost-ledger.js")
        .then((m) => {
          this.costLedger ??= new m.CostLedger(
            path.join(os.homedir(), ".quiver", "cost-ledger.jsonl"),
          );
          this.costLedger.record(entry);
        })
        .catch(() => {
          // Spend attribution must never break a turn.
        });
    } catch {
      // Spend attribution must never break a turn.
    }
  }
  // US-6.1: hash-based read-before-write (compare-and-swap). Replaces the
  // crude Set<string> path tracker with SHA-256 + mtimeMs verification so a
  // file modified between read and write is never silently overwritten.
  private fileReadHistory: FileReadHistory;
  // US-13.4: consecutive-failure loop detection (3 identical failures → pause).
  private failureTracker: ConsecutiveFailureTracker = new ConsecutiveFailureTracker();
  // US-2.2B: the active harness adapter for the current model (alignment layer).
  private adapter: HarnessAdapter | null = null;
  // US-2.2A: the active model provider (transport layer).
  private provider: import("./providers/index.js").ModelProvider | null = null;
  // US-17.17: per-turn sensitivity routing decision. Set by the sensitivity
  // block before the model call; read at the call site to pick the endpoint
  // (high→local) and to send the redacted text (mid→cloud-redacted).
  // The model actually used for the most recent turn (cloud model, or the
  // local model when a high-sensitivity turn routed to the local endpoint).
  // Recorded into saved session state so .state.json reflects reality.
  private lastUsedModel: string = config.llmModelName;
  // The onEvent sink for the current prompt() turn, so helpers like
  // manageContextIfNeeded can emit events (e.g. compaction_proposed).
  private currentOnEvent: ((e: AgentEvent) => void) | null = null;
  private promptDepth = 0;
  private pendingSensitivity: {
    route: "cloud" | "cloud-redacted" | "local";
    redactedText: string;
    refused?: boolean;
  } | null = null;
  // Local provider (US-17.17 high-sensitivity escape hatch). Lazily built.
  private localProvider: import("./providers/index.js").ModelProvider | null = null;
  // US-13.2: checkpoint/crash-recovery manager for this session.
  private checkpointManager: CheckpointManager | null = null;
  // Evidence is owned by this agent session. The tool accesses it through an
  // AsyncLocalStorage scope so concurrent sessions cannot share claims.
  private evidenceTracker = new EvidenceTracker();
  private memoryDecayRun = false;
  private pendingRevisionNote: string | undefined = undefined;
  // US-2.3: Active stream abort controller — allows Ctrl+C / Stop to halt
  // the current LLM stream generation within 1-2 seconds.
  private activeAbortController: AbortController | null = null;
  // Mid-run intervention: lets the user steer the agent while it is running
  // (inject a steering message or request a stop at the next loop boundary).
  private intervention = new InterventionController();
  // Scoped approval cache: "approve all similar this session" so repeated
  // safe actions don't re-prompt every call (US-6.4).
  private approvalCache = new ApprovalCache();
  // Ambient self-heal + goal-loop engine: verifies completed work (tsc+tests)
  // and auto-continues the loop until healthy (US-AMBIENT). On by default.
  private ambient = new GoalLoopEngine(config.ambientMaxHealRounds, config.ambientEnabled);

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    this.logger = new SessionLogger();
    this.fileReadHistory = new FileReadHistory(this.logger.getSessionId());
    // US-13.2: per-turn checkpoints + crash recovery (wired below).
    this.checkpointManager = new CheckpointManager(this.logger.getSessionId(), getProjectId());

    // US-15.1: register the lifecycle interception engine (transparency,
    // provenance, and the maker-checker verification gate). Hooks fire at
    // deterministic stages of the request pipeline — see src/lifecycle.ts.
    try {
      registerBuiltinHooks(lifecycleRegistry, this.logger);
    } catch {
      // Hook registration must never block agent startup.
    }

    // Placeholder until the first turn loads skills/system-prompt/SKILL.md.
    // Product identity lives only in that skill file — do not duplicate it here.
    this.messages.push({
      role: "system",
      content:
        "Quiver is starting. Canonical instructions load from the system-prompt skill on the first turn.",
    });
  }

  // ─── Session persistence ─────────────────────────────────────────────
  // Auto-saves conversation state to disk so it can be resumed after exit/crash.

  private getSessionStatePath(): string {
    return path.join(getProjectSessionsDir(), `${this.logger.getSessionId()}.state.json`);
  }

  /** Save the current conversation state (messages + token stats) to disk. */
  public async saveSessionState(): Promise<void> {
    try {
      const statePath = this.getSessionStatePath();
      const state = {
        format: "quiver-session-state",
        version: "1.0.0",
        sessionId: this.logger.getSessionId(),
        savedAt: new Date().toISOString(),
        model: this.lastUsedModel,
        messages: this.getRedactedMessages(),
        tokenStats: this.tokenStats,
      };
      await atomicWrite(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.logger.logEvent("session_state_save_failed", {
        path: this.getSessionStatePath(),
        error: String(error),
      });
    }
  }

  /**
   * US-2.3: Abort the active LLM stream generation.
   * Called by the SIGINT handler when the user presses Ctrl+C during
   * model generation. Halts the stream within 1-2 seconds, preserves
   * session state and file modifications up to the abort point, and
   * writes a checkpoint.
   */
  public abortActiveStream(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  /** Expose the intervention controller so the CLI can queue steering input. */
  public getInterventionController(): InterventionController {
    return this.intervention;
  }

  /** Expose the scoped approval cache for status/inspection. */
  public getApprovalCache(): ApprovalCache {
    return this.approvalCache;
  }

  /** Expose the ambient engine for /config status display. */
  public getAmbientEngine(): GoalLoopEngine {
    return this.ambient;
  }

  /** Synchronous version of saveSessionState for use in signal handlers. */
  public saveSessionStateSync(): void {
    try {
      const statePath = this.getSessionStatePath();
      const state = {
        format: "quiver-session-state",
        version: "1.0.0",
        sessionId: this.logger.getSessionId(),
        savedAt: new Date().toISOString(),
        model: this.lastUsedModel,
        messages: this.getRedactedMessages(),
        tokenStats: this.tokenStats,
      };
      atomicWriteSync(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      this.logger.logEvent("session_state_save_failed", {
        path: this.getSessionStatePath(),
        error: String(error),
      });
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
      let redactedContent = msg.content;
      if (typeof redactedContent === "string") {
        redactedContent = redactSecrets(redactedContent);
      } else if (Array.isArray(redactedContent)) {
        redactedContent = redactedContent.map((part) => {
          if (part.type === "text" && part.text) {
            return { ...part, text: redactSecrets(part.text) };
          }
          return part;
        });
      }

      const redacted: Message = {
        role: msg.role,
        content: redactedContent,
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
          // Opaque provider echo bags are not secrets — preserve them.
          ...(tc.passthrough ? { passthrough: tc.passthrough } : {}),
          ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
        }));
      }
      return redacted;
    });
  }

  /** US-13.2: write a checkpoint capturing the current turn's state. */
  private async writeCheckpoint(): Promise<void> {
    if (!this.checkpointManager) return;
    const sessionMessages = this.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((p: any) => (p.type === "text" ? p.text : "")).join("")
            : "",
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
      name: m.name,
      timestamp: new Date().toISOString(),
    }));
    await this.checkpointManager.checkpoint({
      messages: sessionMessages as any[],
      approvals: [],
      fileReadHashes: this.fileReadHistory.getAllRecords(),
      model: config.llmModelName,
      adapter: this.adapter?.id ?? "default",
      metadata: {
        total_loops: this.tokenStats.turns,
        total_tool_calls: this.tokenStats.toolCalls,
        total_tokens: this.tokenStats.inputTokens + this.tokenStats.outputTokens,
      },
    });
  }

  // ── Self-Heal: tool-call history repair (US-13.4 / provider 400) ────
  // When a model streams tool-call `arguments` that are not valid JSON
  // (truncated, markdown-wrapped, or malformed), echoing that string back
  // to the provider on the next turn makes the API reject the ENTIRE request
  // with HTTP 400 {"invalid tool call arguments"}. Because the error is
  // permanent (the request body is invalid), the 3× connection-retry loop
  // can never succeed, and the poisoned assistant message stays in history
  // so every subsequent prompt — including a user's "self heal" — 400s
  // identically. These helpers sanitize arguments before persisting (Layer A)
  // and surgically repair already-poisoned history on a 400 (Layer B).

  /**
   * Coerce a raw tool-call arguments string to valid JSON.
   * Returns "{}" for malformed/empty input so the persisted assistant
   * message never carries invalid JSON into the next provider request.
   * Also strips stray ```json fenced wrappers some models emit.
   */
  private sanitizeToolCallArguments(rawArgs: string | undefined): string {
    if (!rawArgs) return "{}";
    let s = rawArgs.trim();
    if (!s) return "{}";
    // Strip ```json ... ``` fences if the model wrapped the args.
    if (s.startsWith("```")) {
      s = s
        .replace(/^```(?:json)?\n?/i, "")
        .replace(/\n?```$/, "")
        .trim();
    }
    try {
      // Validate parseability; JSON.parse accepts numbers/strings too, so
      // require an object or array to match the tool-call contract.
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
      return "{}";
    } catch {
      return "{}";
    }
  }

  /**
   * Repair `this.messages` after a provider 400 "invalid tool call arguments".
   * Scans for assistant messages whose tool_calls carry malformed arguments
   * and fixes them in place, then drops any orphaned `tool` role messages
   * whose tool_call_id no longer references a surviving tool call. Returns
   * the number of messages repaired so the caller can log/decide to retry.
   * Safe to call repeatedly; idempotent.
   */
  private repairToolCallHistory(): number {
    let repaired = 0;
    // First pass: collect surviving tool-call IDs after fixing arguments.
    const survivingCallIds = new Set<string>();
    for (const m of this.messages) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const id = tc?.id || `call_repaired_${repaired}`;
          const sanitized = this.sanitizeToolCallArguments(tc?.function?.arguments);
          if (sanitized !== (tc?.function?.arguments ?? "")) {
            repaired++;
          }
          // Rewrite the tool call in place with a stable id + valid args.
          tc.id = id;
          tc.type = "function";
          tc.function = {
            name: tc?.function?.name || "",
            arguments: sanitized,
          };
          survivingCallIds.add(id);
        }
      }
    }
    // Second pass: drop orphaned tool results.
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => {
      if (m.role !== "tool") return true;
      const orphan = !!m.tool_call_id && !survivingCallIds.has(m.tool_call_id);
      return !orphan;
    });
    repaired += before - this.messages.length;
    return repaired;
  }

  /**
   * Some OpenAI-compat hosts require opaque tool-call fields to be echoed
   * on later turns. Sessions that lack those fields (migrated providers /
   * older Quiver builds) will 400 forever if we keep echoing bare tool_calls.
   * Collapse those cycles into plain assistant text so the conversation can
   * continue — transport recovery, not a product/model path.
   */
  private collapseToolHistoryWithoutPassthrough(): number {
    const hasBare = this.messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((tc) => !toolCallHasPassthrough(tc)),
    );
    if (!hasBare) return 0;

    const next: Message[] = [];
    let collapsed = 0;
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0 &&
        m.tool_calls.some((tc) => !toolCallHasPassthrough(tc))
      ) {
        const lines: string[] = [];
        if (typeof m.content === "string" && m.content.trim()) {
          lines.push(m.content.trim());
        }
        const results: Message[] = [];
        let j = i + 1;
        while (j < this.messages.length && this.messages[j].role === "tool") {
          results.push(this.messages[j]);
          j++;
        }
        for (const tc of m.tool_calls) {
          const result = results.find((r) => r.tool_call_id === tc.id);
          const resultText =
            typeof result?.content === "string"
              ? result.content
              : Array.isArray(result?.content)
                ? result.content.map((p: any) => (p.type === "text" ? p.text : "")).join("\n")
                : "";
          const clipped = resultText.length > 4000 ? `${resultText.slice(0, 4000)}…` : resultText;
          lines.push(
            `[Earlier tool: ${tc.function?.name || "unknown"}(${tc.function?.arguments || "{}"})]\n${clipped}`,
          );
        }
        next.push({
          role: "assistant",
          content: lines.join("\n\n") || "[Earlier tool use summarized]",
        });
        collapsed++;
        i = j - 1;
        continue;
      }
      next.push(m);
    }
    this.messages = next;
    return collapsed;
  }

  /** Flatten multimodal tool parts to plain text for providers that require it. */
  private flattenContentForProvider(content: Message["content"]): string | null {
    if (content == null) return null;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p: any) => {
          if (p?.type === "text") return p.text || "";
          if (p?.type === "image_url") return "[image attached]";
          if (p?.type === "file") return `[file: ${p.file?.filename || "attached"}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return String(content);
  }

  /**
   * Shape messages for the active OpenAI-compat endpoint. Preserves Gemini
   * thought signatures and flattens tool content arrays to strings.
   */
  private normalizeMessagesForProvider(messages: Message[]): any[] {
    return messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.tool_call_id,
          ...(m.name ? { name: m.name } : {}),
          content: this.flattenContentForProvider(m.content) ?? "",
        };
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        return {
          role: "assistant",
          content:
            typeof m.content === "string" && m.content.length === 0
              ? null
              : (this.flattenContentForProvider(m.content) ?? null),
          tool_calls: m.tool_calls.map((tc) => shapeOutboundToolCall(tc)),
        };
      }
      return {
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      };
    });
  }

  /** Load conversation state from a previous session file. */
  public async loadSessionState(statePath: string): Promise<boolean> {
    try {
      const content = await fs.readFile(statePath, "utf8");
      const state = JSON.parse(content);
      if (state.format !== "quiver-session-state") {
        console.error(new CorruptStateError(statePath, "unsupported session state format").message);
        return false;
      }
      // Restore messages (the system prompt will be rebuilt on next prompt())
      this.messages = Array.isArray(state.messages) ? state.messages : [];
      this.tokenStats = state.tokenStats || {
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        turns: 0,
      };
      return true;
    } catch (error: any) {
      if (error instanceof SyntaxError) {
        console.error(new CorruptStateError(statePath, "JSON could not be parsed").message);
      } else {
        console.error(
          `Could not load session state ${statePath}: ${error?.message || String(error)}`,
        );
      }
      return false;
    }
  }

  /** Find the most recent session state file in the project's .sessions/ */
  public static async findLatestSessionState(): Promise<string | null> {
    try {
      const sessionsDir = getProjectSessionsDir();
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

  /** List all saved session state files for the current project. */
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
      const sessionsDir = getProjectSessionsDir();
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
        const filePath = path.join(sessionsDir, f);
        try {
          const content = await fs.readFile(filePath, "utf8");
          const state = JSON.parse(content);
          results.push({
            sessionId: state.sessionId || f,
            path: filePath,
            savedAt: state.savedAt || "unknown",
            messageCount: state.messages?.length || 0,
            model: state.model || "unknown",
          });
        } catch (error: any) {
          results.push({
            sessionId: f.replace(".state.json", ""),
            path: filePath,
            savedAt: "CORRUPT",
            messageCount: 0,
            model: `CORRUPT: ${error?.message || "unreadable state"}`,
          });
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

  /** Delegate to SessionLogger so CLI slash commands can log events. */
  public logEvent(type: string, data: any): void {
    this.logger.logEvent(type, data);
  }

  // Compact conversation history with LLM-powered summarization.
  // Saves the original conversation to a file, generates a real summary,
  // and replaces old messages with the summary + recent messages.
  public async compactHistory(keepLast?: number): Promise<{
    removedCount: number;
    summary: string;
    savedTo: string;
    tokensBefore: number;
    tokensAfter: number;
  }> {
    const keep = keepLast ?? calculateKeepRecent(this.messages);
    const result = await compactWithSummarization(this.messages, keep, this.logger.getSessionId());
    return result;
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

  // US-4.2: background memory extraction - analyze the session trace on a
  // cadence and propose facts to the pending review queue (the user-gated
  // "analyze -> update" loop). Best-effort, fire-and-forget; gated by
  // min-turns + cadence so it never runs on quick chats or every turn.
  private async maybeExtractMemory(): Promise<void> {
    const MIN_TURNS = 5;
    const CADENCE = 8;
    if (this.tokenStats.turns < MIN_TURNS) return;
    if (this.tokenStats.turns % CADENCE !== 0) return;
    try {
      const { analyzeSessionTrace } = await import("./memory/trace_analyzer.js");
      await analyzeSessionTrace(this.logger.getLogs(), this.logger.getSessionId());
    } catch {
      // Best-effort - extraction must never break the agent.
    }
  }

  // Load persistent memory files
  private async loadMemory(): Promise<{ filename: string; sizeBytes: number; content: string }[]> {
    const memoryDir = getProjectMemoryDir();
    const results: { filename: string; sizeBytes: number; content: string }[] = [];

    try {
      await fs.mkdir(memoryDir, { recursive: true });
      const files = await fs.readdir(memoryDir);

      for (const file of files) {
        const filePath = path.join(memoryDir, file);
        const stats = await fs.stat(filePath);
        if (
          stats.isFile() &&
          !file.startsWith(".") &&
          file !== "project.json" &&
          // Principle 1: pending / structured fact stores never enter active
          // context until a human reviews them (GUI already skips facts.jsonl).
          file !== "facts.jsonl" &&
          !file.endsWith(".pending.jsonl") &&
          file !== "review-queue.json"
        ) {
          // S2 / SPEC §6: Skip memory files the user excluded via the
          // context rail consent control (passed via env var from GUI).
          const excludedMemories = (process.env.QUIVER_EXCLUDED_MEMORIES || "")
            .split(",")
            .filter(Boolean);
          if (excludedMemories.includes(file)) continue;

          // H1: cap per-file memory size so a huge file in the memory dir
          // can't blow the context budget. Skip (with a log) above 256 KB.
          if (stats.size > 256 * 1024) {
            await this.logger.logEvent("memory_file_skipped", {
              file,
              sizeBytes: stats.size,
              reason: "exceeds 256 KB memory-file cap; not loaded into context",
            });
            if (config.outputMode === "interactive") {
              console.log(
                picocolors.gray(
                  `  ⚠ Memory file '${file}' is ${(stats.size / 1024).toFixed(0)} KB — exceeds the 256 KB cap, not loaded.`,
                ),
              );
            }
            continue;
          }
          const content = await fs.readFile(filePath, "utf8");
          results.push({
            filename: file,
            sizeBytes: stats.size,
            content,
          });
        }
      }
    } catch {
      // Ignore directory read errors
    }

    // US-12.2: accepted (reviewed) memory facts are part of active prompt
    // assembly — the review queue's "accept" action must reach the model.
    try {
      const reviewedContext = await loadReviewedMemoryContext();
      if (reviewedContext) {
        results.push({
          filename: "reviewed-facts.md",
          sizeBytes: reviewedContext.length,
          content: reviewedContext,
        });
      }
    } catch {
      // Non-critical — never block the turn on memory loading
    }
    return results;
  }

  // US-4.3: track memory citations found in model output.
  private async trackCitations(assistantContent: string): Promise<void> {
    try {
      const adapter =
        this.adapter ||
        getAdapterForModel({
          id: config.llmModelName,
          displayName: config.llmModelName,
          providerId: "default",
          contextWindowTokens: config.maxContextTokens,
          supportsTools: true,
          supportsParallelToolCalls: true,
          supportsImages: false,
          supportsStreaming: true,
          supportsReasoningSummaries: false,
        });
      const citations = adapter.parseMemoryCitations(assistantContent);
      if (citations.length === 0) return;
      // Validate against the memory files that actually exist so false
      // citations (hallucinated doc names) never inflate hit counts.
      const memoryDir = getProjectMemoryDir();
      let existing: string[] = [];
      try {
        existing = (await fs.readdir(memoryDir)).filter(
          (f) => !f.startsWith(".") && f !== "project.json",
        );
      } catch {
        existing = [];
      }
      const formattedCitations = citations.map((c) => ({
        file: c.file,
        section: c.section,
        text: c.text,
        position: (c as any).position ?? 0,
      }));
      const { valid } = validateCitationsImport(formattedCitations, existing);
      if (valid.length > 0) {
        await updateUsageStats(valid);
      }
    } catch {
      // Non-critical — never block the turn on citation tracking.
    }
  }

  // US-4.3: best-effort decay pass — log archival candidates for the user.
  private async runMemoryDecay(): Promise<void> {
    try {
      const allStats = await getAllUsageStatsImport();
      const cfg = getDefaultDecayConfig();
      const candidates = getArchivalCandidates(allStats, cfg);
      if (candidates.length > 0 && config.outputMode === "interactive") {
        const names = candidates.map((c) => c.file).join(", ");
        console.log(
          picocolors.gray(
            `     Memory decay: ${candidates.length} fact(s) cold and rarely cited (${names}). Consider archiving via /memory.`,
          ),
        );
      }
    } catch {
      // Non-critical.
    }
  }

  // Load versioned skills
  private async loadSkills(): Promise<
    { id: string; version: string; purpose: string; content: string }[]
  > {
    const skillsDir = getSkillsDir();
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
            const compatibility = compatMatch ? compatMatch[1].trim() : "Universal";

            results.push({
              id: name,
              version,
              purpose: `${purpose} [License: ${license}, Compatibility: ${compatibility}]`,
              content,
            });
          }
        } catch {
          // No SKILL.md found in this directory
        }
      }
    } catch {
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
  private buildSystemPrompt(coreMemory: any, memories: any[], skills: any[]): string {
    // Load base system prompt from the packaged skill (sole product identity).
    let systemPrompt: string;
    try {
      const promptPath = path.resolve(getSkillsDir(), "system-prompt", "SKILL.md");
      const rawContent = fsSync.readFileSync(promptPath, "utf8");
      // Strip YAML frontmatter
      systemPrompt = rawContent.replace(/^---[\s\S]*?---\s*/, "");
    } catch {
      // Fail closed on identity — do not invent a second product bible.
      systemPrompt =
        "Quiver system-prompt skill is missing. Stop and ask the operator to restore skills/system-prompt/SKILL.md (or re-run quiver init). Do not invent a substitute identity.";
    }

    // US-11.1: deterministic 9-section prompt assembly. The base prompt loaded
    // above is the identity section; core memory, persistent memories, and
    // active skills are mapped into the spec's ordered sections and assembled
    // through assemblePrompt() (with the security preamble injected by the
    // assembler) so the prompt shape is deterministic, not ad-hoc concatenation.
    // core.json "identity" is engagement preference text — NOT a second agent role.
    const projectContext = `--- ENGAGEMENT CONTEXT ---
[Engagement Preferences]: ${coreMemory.identity || ""}
[Human Context]: ${coreMemory.human_context || ""}
[Project Context]: ${coreMemory.project_context || ""}`;

    let memoryContext = "";
    if (memories.length > 0) {
      memoryContext = `--- ACTIVE PERSISTENT MEMORY ---\n`;
      for (const m of memories) {
        memoryContext += `[Memory Snippet: ${m.filename}]\n${m.content}\n\n`;
      }
    }
    // SPEC §7.4: episodic examples (promoted past deliverables) are an
    // episodic-memory component — visible/editable/excludable in the consent
    // gate (§6 layer B) and consulted by the agent on future runs.
    const exampleContext = loadExampleContext();
    if (exampleContext) memoryContext += exampleContext + "\n";

    // Append active skills (excluding the system-prompt skill itself)
    const activeSkills = skills.filter((s) => s.id !== "quiver-system-prompt");
    let toolInstructions = "";
    if (activeSkills.length > 0) {
      toolInstructions = `--- ACTIVE TASK PROCEDURES (SKILLS) ---\n`;
      for (const s of activeSkills) {
        toolInstructions += `[Skill: ${s.id} (v${s.version})]\nPurpose: ${s.purpose}\nInstructions:\n${s.content}\n\n`;
      }
    }

    // Append MCP server instructions (if any MCP servers are connected)
    let mcpInstructions = "";
    try {
      const mcpInstr = mcpManager.getInstructions();
      if (mcpInstr) {
        mcpInstructions = `--- MCP SERVER INSTRUCTIONS ---\n${mcpInstr}\n\n`;
      }
    } catch {
      // MCP not loaded — skip
    }

    const modelInfo: ModelInfo = {
      id: config.llmModelName,
      displayName: config.llmModelName,
      providerId: this.provider?.id ?? "default",
      contextWindowTokens: config.maxContextTokens,
      supportsTools: true,
      supportsParallelToolCalls: true,
      supportsImages: false,
      supportsStreaming: true,
      supportsReasoningSummaries: false,
    };
    const adapter = this.adapter ?? getAdapterForModel(modelInfo);
    const assembled = assemblePrompt(
      {
        identity: systemPrompt,
        safetyPolicy: SECURITY_PREAMBLE,
        adapterInstructions: "",
        toolInstructions: toolInstructions + mcpInstructions,
        memoryContext,
        projectContext,
        conversationSummary: "",
        recentMessages: [],
        currentUserRequest: "",
      },
      adapter,
      modelInfo,
    );
    return assembled.systemPrompt;
  }

  /**
   * Estimate token count for a message (rough heuristic: ~4 chars per token).
   */
  private estimateTokens(text: string): number {
    return Math.ceil((text || "").length / 4);
  }

  /**
   * Manages context for very long conversations.
   * 1. Offloads large tool results to files (replaces with references)
   * 2. If still over threshold, triggers LLM-powered summarization
   *
   * This replaces the old crude trimContextIfNeeded that just deleted messages.
   * Now information is preserved — either in files or in an LLM summary.
   */
  private async manageContextIfNeeded(): Promise<{
    offloaded: number;
    compacted: number;
    summary: string;
    savedTo: string;
  }> {
    // Step 1: Offload large tool results
    const offloaded = await offloadLargeToolResults(this.messages, this.logger.getSessionId());

    // Step 2: Check if we still need compaction
    if (!needsCompaction(this.messages)) {
      return { offloaded, compacted: 0, summary: "", savedTo: "" };
    }

    // SPEC §7.3: compaction is a CONSENT gate, not a silent rewrite. Propose
    // (save the full history + generate the summary, WITHOUT mutating), surface
    // the proposal, and apply ONLY if the user approves. Decline → the live
    // conversation stays full; the saved copy is the accessible full history.
    const keepRecent = calculateKeepRecent(this.messages);
    const proposal = await proposeCompaction(this.messages, keepRecent, this.logger.getSessionId());
    if (!proposal.needed) {
      return { offloaded, compacted: 0, summary: "", savedTo: "" };
    }

    // Surface the proposal (GUI event + CLI prompt) and wait for a decision.
    // Consent: apply ONLY if the user approves (SPEC §7.3). Interactive and
    // JSON (GUI) modes both block on stdin — the GUI answers via the same
    // askQuestionRaw path as the consent gate. Quiet/CI must not silently
    // rewrite context unless QUIVER_AUTO_COMPACT=1 is set explicitly.
    if (this.currentOnEvent) {
      this.currentOnEvent({
        type: "compaction_proposed",
        data: {
          removedCount: proposal.removedCount,
          keptRecent: proposal.keptRecent,
          tokensBefore: proposal.tokensBefore,
          tokensAfter: proposal.tokensAfter,
          savedTo: proposal.savedTo,
          summary: proposal.summary,
        },
      });
    }
    let approved = false;
    if (config.outputMode === "quiet") {
      approved = process.env.QUIVER_AUTO_COMPACT === "1";
    } else {
      try {
        const { askQuestionRaw } = await import("./utils/prompt.js");
        if (config.outputMode === "interactive") {
          const { card } = await import("./cli_ui.js");
          const shortPath = proposal.savedTo.replace(os.homedir(), "~");
          card({
            title: "Context compaction proposed",
            body: [
              `${proposal.removedCount} messages → summary, keep ${proposal.keptRecent} recent`,
              `${proposal.tokensBefore.toLocaleString("en-US")} → ${proposal.tokensAfter.toLocaleString("en-US")} tokens`,
              `Full history saved to ${shortPath}`,
            ],
            footer:
              "The summary replaces old messages in this session. Your full history is preserved in the file above.",
            accent: "brand",
          });
        }
        const ans = (
          await askQuestionRaw(
            config.outputMode === "interactive"
              ? picocolors.bold(picocolors.cyan("  Approve? [Y/n]: "))
              : "",
          )
        )
          .trim()
          .toLowerCase();
        // Interactive defaults to yes on empty (Y/n); JSON/GUI requires explicit approve.
        if (config.outputMode === "interactive") {
          approved = !ans.startsWith("n");
        } else {
          approved = /^(a|y|yes|approve|allow)$/.test(ans);
        }
      } catch {
        approved = false; // fail closed — never silently compact
      }
    }
    await this.logger.logEvent("compaction_decision", {
      approved,
      removedCount: proposal.removedCount,
      keptRecent: proposal.keptRecent,
      tokensBefore: proposal.tokensBefore,
      tokensAfter: proposal.tokensAfter,
      savedTo: proposal.savedTo,
    });
    if (!approved) {
      if (config.outputMode === "interactive") {
        console.log(picocolors.gray("     Compaction declined — full conversation retained."));
      }
      return { offloaded, compacted: 0, summary: "", savedTo: proposal.savedTo };
    }

    // Approved — apply the proposal (replace the live message array).
    applyCompaction(this.messages, proposal);
    if (config.outputMode === "interactive") {
      console.log(
        picocolors.gray(
          `     Context compacted: ${proposal.removedCount} messages summarized, ` +
            `${proposal.tokensBefore.toLocaleString()} → ${proposal.tokensAfter.toLocaleString()} tokens. ` +
            `Full conversation saved to: ${proposal.savedTo}`,
        ),
      );
    }

    return {
      offloaded,
      compacted: proposal.removedCount,
      summary: proposal.summary,
      savedTo: proposal.savedTo,
    };
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
    log_tokens: "Log stats",
    web_search: "Web search",
    scrape_url: "Read webpage",
    browser_control: "Browser",
    memory_append: "Save memory",
    memory_replace: "Update memory",
    deep_research: "Deep research",
    find_all: "Find entities",
    entity_search: "Entity search",
    glob: "Find files",
    apply_patch: "Apply patch",
    todo_write: "Task list",
    ask_question: "Ask user",
    continual_learning: "Learn from sessions",
    subagent: "Subagent",
    office_doc: "Office document",
    evidence: "Evidence tracker",
    data_query: "Data query",
    bar_critic: "Bar critic",
    pdf_read: "Read PDF",
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
        return truncateForDisplay(String(args[field]));
      }
    }
    return "";
  }

  /** Generate a truncated preview of a tool result for user display. */
  private summarizeResult(result: any): string {
    if (!result) return "";
    let str: string;
    if (typeof result === "string") {
      str = result;
    } else {
      try {
        str = JSON.stringify(result);
      } catch {
        str = String(result);
      }
    }
    if (str.length <= 120) return str;
    // Truncate to 120 chars, preserving word boundaries
    const truncated = str.substring(0, 117);
    const lastSpace = truncated.lastIndexOf(" ");
    const clean = lastSpace > 80 ? truncated.substring(0, lastSpace) : truncated;
    return `${clean}…`;
  }

  // ── Context Manifest ───────────────────────────────────────────────
  // Shows the user exactly what context will enter the model call:
  // memory, skills, tools, model, and context window usage — before the call.
  // This is the core transparency principle: the user should never wonder
  // "what did the AI see?" or "how much context is left?"
  private printContextManifest(memories: any[], skills: any[], _coreMemory: any): void {
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

    // Count native multimodal attachments in the latest user message
    const lastMsg = this.messages[this.messages.length - 1];
    const imageCount = Array.isArray(lastMsg?.content)
      ? lastMsg.content.filter((p: any) => p.type === "image_url" || p.type === "file").length
      : 0;

    // ── Line 1: a calm summary sentence — what enters the model call ──
    // Filter out internal skills (plumbing, not business capabilities — the
    // GUI already hides these via isInternalSkill(); the CLI should too).
    const userSkills = skills.filter((s: any) => !/system-prompt/i.test(String(s.id || "")));
    const summaryBits: string[] = [];
    summaryBits.push(`${memories.length} memory`);
    if (userSkills.length > 0)
      summaryBits.push(`${userSkills.length} skill${userSkills.length > 1 ? "s" : ""}`);
    summaryBits.push(`${this.registry.getAllTools().length} tools`);
    let mcpCount = 0;
    try {
      const status = mcpManager.getStatus();
      mcpCount = status.filter((s: any) => s.connected).length;
      if (mcpCount > 0) summaryBits.push(`${mcpCount} MCP`);
    } catch {}
    if (imageCount > 0) summaryBits.push(`${imageCount} image${imageCount > 1 ? "s" : ""}`);

    // ── Line 2: the details — what files, what model, how much context ──
    const detailBits: string[] = [];
    if (memories.length > 0) {
      detailBits.push(memories.map((m: any) => m.filename).join(", "));
    }
    if (userSkills.length > 0) {
      detailBits.push(userSkills.map((s: any) => `${s.id} v${s.version}`).join(", "));
    }

    // Compact token usage: 27k/120k (23%) with a block bar
    const compactTok = (n: number) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
    const tokColor = pct < 60 ? picocolors.gray : pct < 85 ? picocolors.yellow : picocolors.red;
    const barWidth = 8;
    const barFilled = Math.round((pct / 100) * barWidth);
    const bar = "■".repeat(barFilled) + "⬝".repeat(barWidth - barFilled);

    // Line 1: the summary — model + counts, calm
    console.log(
      dim(`  `) +
        picocolors.white(config.llmModelName) +
        dim(` · ${summaryBits.join(" · ")} · `) +
        tokColor(`${compactTok(estTokens)}/${compactTok(maxTokens)}`) +
        dim(` ${bar}`),
    );

    // Line 2: the details — file names + skill names (only if there are any)
    if (detailBits.length > 0) {
      console.log(dim(`  `) + dim(detailBits.join(" · ")));
    }
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
  public isPromptRunning(): boolean {
    return this.promptDepth > 0;
  }

  public async prompt(
    userInput: string,
    onToken: (token: string) => void,
    onEvent?: (event: AgentEvent) => void,
    engagementSensitivity?: import("./security/sensitivity.js").EngagementSensitivity,
  ): Promise<void> {
    if (this.promptDepth > 0) {
      throw new Error(
        "A workflow callback cannot start a nested agent turn while the current turn is running.",
      );
    }
    this.promptDepth++;
    try {
      await this.promptTurn(userInput, onToken, onEvent, engagementSensitivity);
    } finally {
      this.promptDepth--;
    }
  }

  private async promptTurn(
    userInput: string,
    onToken: (token: string) => void,
    onEvent?: (event: AgentEvent) => void,
    engagementSensitivity?: import("./security/sensitivity.js").EngagementSensitivity,
  ): Promise<void> {
    this.currentOnEvent = onEvent ?? null;
    const { setAgentUiEventSink } = await import("./agent_ui_events.js");
    setAgentUiEventSink(onEvent ? (ev) => onEvent(ev as AgentEvent) : null);
    try {
      await this.promptTurnBody(userInput, onToken, onEvent, engagementSensitivity);
    } finally {
      setAgentUiEventSink(null);
      this.currentOnEvent = null;
    }
  }

  private async promptTurnBody(
    userInput: string,
    onToken: (token: string) => void,
    onEvent?: (event: AgentEvent) => void,
    engagementSensitivity?: import("./security/sensitivity.js").EngagementSensitivity,
  ): Promise<void> {
    // US-4.3: run a best-effort memory decay pass once per session so stale,
    // never-cited facts surface as archival candidates (provenance + decay).
    if (!this.memoryDecayRun) {
      this.memoryDecayRun = true;
      this.runMemoryDecay().catch(() => {});
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

    // Manage context for long conversations before adding new user message.
    // Large results are archived and compaction uses a local structural
    // summary; it never makes a hidden auxiliary model call.
    await this.manageContextIfNeeded();

    // Context manifest — a single dim line showing what enters the model call
    // (memory, skills, tools, model, context % with a block progress bar).
    // Printed before each turn so the user sees what Quiver will use.
    if (config.outputMode === "interactive") {
      this.printContextManifest(memories, skills, coreMemory);
    }

    // In JSON mode, emit context manifest as an event for the GUI
    if (config.outputMode === "json" && onEvent) {
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
      onEvent({
        type: "context_manifest",
        data: {
          model: config.llmModelName,
          memory: memories.map((m: any) => m.filename).join(", ") || "—",
          skills: skills.map((s: any) => `${s.id} v${s.version}`).join(", ") || "—",
          // Structured skill list so the GUI can render real names + versions
          // in the context rail (Epic 2 §2.6 — honest surfaces).
          skillsDetail: skills.map((s: any) => ({
            id: s.id,
            version: s.version,
          })),
          tools: String(this.registry.getAllTools().length),
          examples: String(listExamples().length),
          // Tool names let the GUI show the actual tool catalog (spec §6
          // layer C) instead of a bare count.
          toolNames: this.registry.getAllTools().map((t) => t.name),
          // en-US grouping regardless of system locale (Epic 2 §2.6).
          tokens: `${estTokens.toLocaleString("en-US")} / ${config.maxContextTokens.toLocaleString("en-US")}`,
        },
      });
    }

    // ── Sensitivity routing (US-17.17 / SPEC §4.3 + §11.2) ──
    // Classify the user input from explicit engagement configuration, redact
    // configured patterns for the mid tier, and route high tier to LOCAL.
    // Missing or invalid configuration refuses the turn before any model call.
    let effectiveUserInput = userInput;
    this.pendingSensitivity = null;
    try {
      const { applySensitivityRouting, formatRedactionReceipt } =
        await import("./security/sensitivity.js");
      const sensResult = applySensitivityRouting(userInput, undefined, engagementSensitivity);
      this.pendingSensitivity = {
        route: sensResult.route,
        redactedText: sensResult.redactedText,
      };
      if (sensResult.route === "cloud-redacted") {
        // Mid tier: send the redacted text, not the raw input.
        effectiveUserInput = sensResult.redactedText;
      }
      if (sensResult.redactions.length > 0) {
        await this.logger.logEvent("sensitivity_redaction", {
          tier: sensResult.tier,
          route: sensResult.route,
          reason: sensResult.reason,
          redactions: sensResult.redactions.map((r: any) => ({
            type: r.type,
            originalLength: r.original.length,
            redacted: r.redacted,
          })),
          receipt: formatRedactionReceipt(sensResult.redactions),
          enforced: sensResult.route === "cloud-redacted",
        });
        if (config.outputMode === "interactive") {
          console.log(
            picocolors.gray(
              `  Protected identifiers redacted before sending (${formatRedactionReceipt(sensResult.redactions)}).`,
            ),
          );
        }
      } else if (sensResult.tier !== "low") {
        // Audit mid/high routing silently when nothing was redacted — do not
        // dump engagement-policy jargon into the customer welcome path.
        await this.logger.logEvent("sensitivity_routing", {
          tier: sensResult.tier,
          route: sensResult.route,
          reason: sensResult.reason,
        });
      }
      // High tier: route to a local model endpoint. If none is configured,
      // REFUSE the turn — never send high-sensitivity content to the cloud.
      if (sensResult.route === "local") {
        const { getLocalProvider } = await import("./providers/index.js");
        this.localProvider = getLocalProvider();
        if (!this.localProvider || !config.localLlmModelName) {
          this.pendingSensitivity = {
            route: "local",
            redactedText: sensResult.redactedText,
            refused: true,
          };
          await this.logger.logEvent("sensitivity_refused", {
            tier: sensResult.tier,
            reason:
              "high-sensitivity input but no local model endpoint configured (set QUIVER_LOCAL_LLM_API_BASE_URL + QUIVER_LOCAL_LLM_MODEL_NAME); refused rather than send to the cloud",
          });
          if (config.outputMode === "interactive") {
            console.log(
              picocolors.red(
                "\n  ⚠ Refused: this input is high-sensitivity and no local model endpoint is configured. Set QUIVER_LOCAL_LLM_API_BASE_URL and QUIVER_LOCAL_LLM_MODEL_NAME (e.g. a localhost Ollama) so high-sensitivity content never goes to the cloud. Your message was not sent.",
              ),
            );
          }
          if (onEvent) {
            onEvent({
              type: "sensitivity_refused",
              data: { reason: "no local model endpoint configured" },
            });
            onEvent({ type: "done", data: { refused: true } });
          }
          return;
        }
        if (config.outputMode === "interactive") {
          console.log(
            picocolors.gray(
              `  ↳ routing to local model (${config.localLlmModelName} @ ${config.localLlmBaseUrl}) — content does not leave this machine.`,
            ),
          );
        }
      }
    } catch (error) {
      const reason = String(error);
      this.pendingSensitivity = {
        route: "local",
        redactedText: "",
        refused: true,
      };
      await this.logger.logEvent("sensitivity_refused", {
        reason: `Sensitivity routing could not be established; no model call was made: ${reason}`,
      });
      if (config.outputMode === "interactive") {
        console.log(
          picocolors.red(
            `\n  ⚠ Refused: sensitivity configuration is missing or invalid. ${reason}`,
          ),
        );
      }
      if (onEvent) {
        onEvent({
          type: "sensitivity_refused",
          data: { reason: "invalid or missing sensitivity configuration" },
        });
        onEvent({ type: "done", data: { refused: true } });
      }
      return;
    }

    // Append the user message — the EFFECTIVE input (redacted for mid tier),
    // with [File: path] markers processed for vision. For high tier the raw
    // text is used (it goes to the local endpoint, not the cloud).
    const processedContent = await processFileMarkers(effectiveUserInput);
    this.messages.push({ role: "user", content: processedContent });
    await this.logger.logEvent("user_input", {
      content: effectiveUserInput,
      redacted: effectiveUserInput !== userInput,
    });

    // ── Consent gate (SPEC §6 — "a gate, not a post-hoc log") ──
    // When enabled, the agent surfaces the pre-action summary and WAITS for
    // the user to approve / decline / exclude before the model call. Decline
    // aborts the turn; exclude routes back to the context rail. The decision
    // is logged to the tamper-evident audit chain. When the gate is off,
    // behaviour is unchanged (the summary is informational only).
    try {
      const { isConsentGateEnabled, renderConsentGateCompact } =
        await import("./security/consent_gate.js");
      if (isConsentGateEnabled()) {
        const systemSkill = skills.find((s: any) => s.id === "quiver-system-prompt");
        const gateData = {
          systemPromptVersion: String(systemSkill?.version || "unknown"),
          memoryFiles: memories.map((m: any) => m.filename),
          personaSummary: coreMemory.identity || "Quiver",
          skills: skills.map((s: any) => ({ id: s.id, version: s.version })),
          toolCount: this.registry.getAllTools().length,
          toolNames: this.registry.getAllTools().map((t) => t.name),
          mcpServerCount: 0,
          turnCount: this.messages.filter((m) => m.role === "user").length,
          compactedCount: 0,
          userRequestPreview: userInput.substring(0, 60),
          webSourceCount: 0,
          modelName: config.llmModelName,
          trustTier: (config as any).trustTier || null,
          tokenEstimate: `${Math.ceil(userInput.length / 4)} tokens`,
          scratchMode: false,
        };
        const compact = renderConsentGateCompact(gateData);
        if (config.outputMode === "interactive") {
          console.log(picocolors.gray(`  ${compact}`));
        }
        // Emit a dedicated event so the desktop app renders the gate overlay.
        if (onEvent) {
          onEvent({ type: "consent_gate", data: gateData as any });
        }
        // BLOCK: wait for the user's decision before the model call. In
        // --json (GUI) mode this reads one line the renderer sends via the
        // consent:respond IPC; in interactive mode the user types it.
        // H3: a consent gate must default to DENY — an empty line, "ok",
        // "no", or any unrecognized input must NOT approve sending context
        // to the model. Only an explicit approve/yes/a/y proceeds.
        const { askQuestionRaw } = await import("./utils/prompt.js");
        const raw = (
          await askQuestionRaw(picocolors.gray("  Consent gate — approve / decline / exclude: "))
        )
          .trim()
          .toLowerCase();
        const action: "approve" | "decline" | "exclude" = raw.startsWith("e")
          ? "exclude"
          : /^(a|y|yes|approve|allow)$/.test(raw)
            ? "approve"
            : "decline";
        this.logger.logConsentDecision({
          action,
          model: config.llmModelName,
          memoryCount: memories.length,
          skillsCount: skills.length,
          toolCount: this.registry.getAllTools().length,
        });
        if (action === "decline" || action === "exclude") {
          // Abort the turn — do NOT proceed to the model call. Pop the user
          // message so the conversation is not left with an unanswered turn.
          this.messages.pop();
          if (config.outputMode === "interactive") {
            console.log(
              picocolors.yellow(
                action === "decline"
                  ? "\n  Consent declined — turn aborted."
                  : "\n  Routed back to the context rail — exclude items, then re-run.",
              ),
            );
          }
          if (onEvent) {
            onEvent({
              type: action === "decline" ? "consent_declined" : "consent_exclude",
              data: { action },
            });
            onEvent({
              type: "done",
              data: { consent: action, refused: true },
            });
          }
          return;
        }
        if (config.outputMode === "interactive") {
          console.log(picocolors.green("  Consent approved — proceeding."));
        }
      }
    } catch {
      // A missing or broken consent gate is a safety failure, not permission
      // to continue. The model call must never happen when the gate cannot
      // establish an explicit decision.
      await this.logger.logEvent("consent_declined", {
        action: "decline",
        reason: "consent gate unavailable or failed",
      });
      this.messages.pop();
      if (config.outputMode === "interactive") {
        console.log(
          picocolors.red("\n  Consent unavailable — turn aborted. No model call was made."),
        );
      }
      if (onEvent) {
        onEvent({
          type: "consent_declined",
          data: { action: "decline", reason: "consent gate unavailable" },
        });
        onEvent({ type: "done", data: { consent: "decline", refused: true } });
      }
      return;
    }

    let loopCount = 0;
    let lastAssistantContent = "";
    // Hardcoded safety net — the model decides when to stop (no tool calls = done).
    // This only catches pathological infinite loops, not normal work.
    const maxLoops = 1000;
    // US-AMBIENT: each user goal gets a fresh self-heal budget, and we track
    // whether this turn mutated files so the ambient verify gate only fires
    // for doing-tasks (questions never trigger a verify loop).
    this.ambient.reset();
    let mutatedThisTurn = false;
    let ambientVerificationFailed = false;

    while (true) {
      // ── Mid-run intervention (US-INT) ──
      // Consume any steering message the user queued while the agent was
      // running. The injection lands as a user message BEFORE the model call
      // in this iteration, so the model sees the new instruction together
      // with its prior tool results. A stop request halts the loop cleanly.
      const intervention = this.intervention.consume();
      if (intervention.stop) {
        if (config.outputMode === "interactive") {
          console.log(picocolors.yellow("\n  Stopped."));
        }
        await this.logger.logEvent("user_intervention", { action: "stop" });
        if (onEvent) {
          onEvent({ type: "intervention", data: { text: "stop" } });
        }
        break;
      }
      if (intervention.inject) {
        this.messages.push({ role: "user", content: intervention.inject });
        await this.logger.logEvent("user_intervention", {
          action: "inject",
          content: intervention.inject,
        });
        if (config.outputMode === "interactive") {
          console.log(
            picocolors.cyan(
              `\n↳ Intervention injected: ${picocolors.gray(intervention.inject.slice(0, 120))}`,
            ),
          );
        }
        if (onEvent) {
          onEvent({
            type: "intervention",
            data: { text: intervention.inject },
          });
        }
        // Fall through: the model call below will see the injected message.
      }

      if (loopCount >= maxLoops) {
        if (config.outputMode !== "json") {
          console.warn(
            picocolors.yellow(
              `\nSafety limit reached (${maxLoops} iterations). The model did not stop on its own.`,
            ),
          );
        }
        break;
      }
      loopCount++;
      this.tokenStats.turns++;
      await this.logger.logEvent("turn_start", {
        loop: loopCount,
        historySize: this.messages.length,
      });

      // Gather current tool definitions — strip tools removed by the
      // deployment profile (air-gapped / private-network) below the prompt.
      const { resolveDeploymentProfile, profileConfig } =
        await import("./security/execution_context.js");
      const removedByProfile = new Set(profileConfig(resolveDeploymentProfile()).removedTools);
      const activeTools = this.registry.getAllTools().filter((t) => !removedByProfile.has(t.name));
      const openAiDefs = activeTools.map(ToolRegistry.getOpenAIToolDefinition);

      // US-2.2A/2.2B: resolve the active model provider (transport) and harness
      // adapter (alignment) for the current model. Both are cached for the
      // session so the Model-Harness-Fit architecture — the product's central
      // differentiator — actually drives the real agent loop, not just tests.
      if (!this.provider) {
        this.provider = getActiveProvider();
      }
      // US-17.17: per-turn sensitivity routing. High-sensitivity turns route
      // to the local model endpoint (this.localProvider, set by the
      // sensitivity block); everything else uses the cached cloud provider.
      const route = this.pendingSensitivity?.route;
      const turnProvider =
        route === "local" && this.localProvider ? this.localProvider : this.provider;
      const turnModel =
        route === "local" && this.localProvider ? config.localLlmModelName : config.llmModelName;
      this.lastUsedModel = turnModel;
      let modelInfo: ModelInfo;
      try {
        modelInfo = await turnProvider!.getModelInfo(turnModel);
      } catch {
        modelInfo = {
          id: turnModel,
          displayName: turnModel,
          providerId: turnProvider!.id,
          contextWindowTokens: config.maxContextTokens,
          supportsTools: true,
          supportsParallelToolCalls: true,
          supportsImages: false,
          supportsStreaming: true,
          supportsReasoningSummaries: false,
        };
      }
      // Use a per-turn adapter for the local model without disturbing the
      // cached cloud adapter (a local model id may map to a different adapter).
      const turnAdapter =
        route === "local" && this.localProvider
          ? getAdapterForModel(modelInfo)
          : (this.adapter ?? getAdapterForModel(modelInfo));
      if (route !== "local" && !this.adapter) {
        this.adapter = turnAdapter;
      }
      const adapterDefaults = turnAdapter.getDefaults(modelInfo);

      // Route tool definitions through the adapter's format mapping (US-2.2B).
      const tools = turnAdapter.formatTools(
        activeTools.map((t, idx) => ({
          name: t.name,
          description: t.description,
          parameters: openAiDefs[idx].function?.parameters,
        })),
      ) as any[];

      // Note: the request actually sent to the provider is built inline at the
      // streamChat call below (model: turnModel). An earlier `payload` object
      // here was dead code (built but never consumed) — removed.

      // Spinner for better UX while waiting for API response
      const spinner = new Spinner(loopCount === 1 ? "Thinking…" : "Working…");
      spinner.start();

      // US-11.2 / US-3.3: model-aware token budget with the 0.85 compaction
      // formula. A hard stop blocks submission when the payload exceeds the
      // model's context window — we compact and retry instead of sending an
      // over-limit payload the provider will reject.
      const conversationText = this.messages
        .map((m) => {
          if (typeof m.content === "string") return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join(" ");
          }
          return "";
        })
        .join(" ");
      const systemPromptStr =
        typeof this.messages[0]?.content === "string" ? (this.messages[0].content as string) : "";
      const budget = calculateBudget(
        {
          systemPrompt: systemPromptStr,
          memoryContext: "",
          toolDefinitions: JSON.stringify(tools),
          conversationBuffer: conversationText,
        },
        modelInfo,
        turnAdapter,
      );
      if (shouldBlockSubmission(budget)) {
        spinner.stop();
        await this.manageContextIfNeeded();
        spinner.start();
      }

      // ── Lifecycle: BEFORE_MODEL → wrap_model_call → AFTER_MODEL (US-15.1).
      // The interception engine fires its transparency/provenance hooks here;
      // the maker-checker verification gate lives on wrap_tool_call instead.
      const lifecycleCtx: LifecycleContext = {
        userInput,
        messages: this.messages,
        systemPrompt: systemPromptStr,
        tools,
        model: turnModel,
        isVision: false,
        sessionId: this.logger.getSessionId(),
        loopCount,
        metadata: {},
      };

      let assistantContent = "";
      let firstStreamingToken = true;
      let accumulatedToolCalls: Record<
        number,
        {
          id?: string;
          name?: string;
          arguments: string;
          passthrough?: ToolCallPassthrough;
        }
      > = {};
      let streamFinishReason: string | undefined;
      let truncationRetries = 0;
      const maxTruncationRetries = 2;
      // Self-Heal Layer B: one-shot guard so a 400 "invalid tool call
      // arguments" triggers history repair + retry at most once per turn.
      let historyRepaired = false;

      const runModel = async () => {
        let retries = 0;
        const maxRetries = 3;
        // US-2.3: Create an AbortController for this stream so Ctrl+C can
        // halt generation. Stored on the instance so abortActiveStream()
        // can signal it from the SIGINT handler. Recreated on each retry
        // because abort() nullifies it — a retry with a null controller
        // crashes with "Cannot read properties of null (reading 'signal')".
        this.activeAbortController = new AbortController();
        // Rebuild outbound messages on every attempt so self-heal repairs stick.
        let redactMessageContentFn: ((content: unknown) => unknown) | null = null;
        if (route === "cloud-redacted") {
          const sens = await import("./security/sensitivity.js");
          redactMessageContentFn = sens.redactMessageContent;
        }

        const messagesForAttempt = (): any[] => {
          const redactedHistory = this.messages.map((m) => {
            let content = m.content;
            if (redactMessageContentFn) {
              content = redactMessageContentFn(content) as Message["content"];
            }
            if (typeof content === "string") content = redactSecrets(content);
            else if (Array.isArray(content)) {
              content = content.map((p: any) =>
                p.type === "text" ? { ...p, text: redactSecrets(p.text) } : p,
              ) as Message["content"];
            }
            return { ...m, content };
          });
          return this.normalizeMessagesForProvider(redactedHistory);
        };

        while (true) {
          try {
            for await (const ev of turnProvider!.streamChat(
              {
                model: turnModel,
                messages: messagesForAttempt(),
                tools,
                temperature: config.temperature,
                ...(config.topP !== undefined ? { topP: config.topP } : {}),
                ...(config.topK !== undefined ? { topK: config.topK } : {}),
                ...(config.reasoningEffort !== undefined
                  ? { reasoningEffort: config.reasoningEffort }
                  : {}),
                maxTokens: adapterDefaults.maxOutputTokens,
                stream: true,
              },
              this.activeAbortController.signal,
            )) {
              if (ev.type === "text_delta" && ev.content) {
                // Stop the spinner on the first visible token so its 80ms
                // \r<frame> Thinking… repaint no longer clobbers the start of
                // the streamed line (which dropped the first 1-2 chars of each
                // line of assistant output — the "missing letters" UX bug).
                if (firstStreamingToken) {
                  spinner.stop();
                  firstStreamingToken = false;
                }
                assistantContent += ev.content;
                this.tokenStats.outputTokens += this.estimateTokens(ev.content);
                onToken(ev.content);
                if (onEvent) {
                  onEvent({ type: "token", data: { text: ev.content } });
                }
              } else if (ev.type === "tool_call_start") {
                const idx = ev.toolCallIndex ?? 0;
                if (!accumulatedToolCalls[idx]) {
                  accumulatedToolCalls[idx] = { arguments: "" };
                }
                if (ev.toolCallId) accumulatedToolCalls[idx].id = ev.toolCallId;
                if (ev.toolCallName) accumulatedToolCalls[idx].name = ev.toolCallName;
                const bag = ev.toolCallPassthrough || ev.toolCallExtraContent;
                if (bag) {
                  accumulatedToolCalls[idx].passthrough = mergeToolCallPassthrough(
                    accumulatedToolCalls[idx].passthrough,
                    bag,
                  );
                }
              } else if (ev.type === "tool_call_delta") {
                const idx = ev.toolCallIndex ?? 0;
                if (!accumulatedToolCalls[idx]) {
                  accumulatedToolCalls[idx] = { arguments: "" };
                }
                if (ev.toolCallId && !accumulatedToolCalls[idx].id) {
                  accumulatedToolCalls[idx].id = ev.toolCallId;
                }
                if (ev.toolCallArguments) {
                  accumulatedToolCalls[idx].arguments += ev.toolCallArguments;
                }
                const bag2 = ev.toolCallPassthrough || ev.toolCallExtraContent;
                if (bag2) {
                  accumulatedToolCalls[idx].passthrough = mergeToolCallPassthrough(
                    accumulatedToolCalls[idx].passthrough,
                    bag2,
                  );
                }
              } else if (ev.type === "done") {
                // Capture finish_reason from the provider's done event.
                // "length" means the model hit max_output_tokens and was
                // truncated mid-generation — we handle this after the stream
                // completes (below) to decide whether to continue or retry.
                // Only capture the FIRST non-null finishReason — the provider
                // may emit a second "done" (e.g. from [DONE] marker) with
                // finishReason "stop" which would overwrite a real "length".
                if (ev.finishReason && !streamFinishReason) {
                  streamFinishReason = ev.finishReason;
                }
                // Per-engagement spend attribution (chat plane): real provider
                // usage (and OpenRouter's real cost when reported) lands in
                // the same ledger the workflow plane uses. Never content —
                // ids, token counts, and dollars only.
                if (ev.usage) {
                  this.recordChatUsage(ev.usage, turnModel);
                }
              } else if (ev.type === "error") {
                throw new Error(ev.error || "Provider stream error");
              } else if (ev.type === "reasoning_delta") {
                // Chain-of-thought tokens from Kimi-K3 and similar models.
                // Per US-2.2 (HIDDEN-COT-NOT-PERSISTED): do NOT accumulate
                // into assistantContent, do NOT log to audit trail, do NOT
                // display to user. Silently consume.
              } else if (ev.type === "unsupported") {
                // Total event classification: unknown provider events are
                // surfaced to the user and logged, never silently dropped.
                // This makes debugging provider issues much easier — the
                // user can see exactly what the provider sent that Quiver
                // didn't understand.
                if (config.outputMode === "interactive") {
                  console.log(
                    picocolors.gray(`   Unsupported event: ${ev.rawDescription || "unknown"}`),
                  );
                }
                this.logger.logEvent("unsupported_stream_event", {
                  description: ev.rawDescription,
                  raw: ev.rawEvent,
                  loopCount,
                });
              }
            }
            return { assistantContent, accumulatedToolCalls };
          } catch (err: any) {
            // Self-Heal Layer B: a 400 "invalid tool call arguments" is a
            // PERMANENT error — the request body contains a malformed
            // tool_call.arguments string (poisoned history). Retrying the
            // same request 3× can never succeed, and the poisoned message
            // would 400 every future prompt including a user's "self heal".
            // Detect it, repair the history, and retry once with a fresh
            // attempt budget. `historyRepaired` guards against loops.
            const msg = String(err?.message || "");
            const isInvalidToolArgs =
              /invalid tool call arguments|invalid_request_error/.test(msg) ||
              /Provider error 400/.test(msg) ||
              /INVALID_ARGUMENT|invalid argument|thought_signature/i.test(msg);
            if (isInvalidToolArgs && !historyRepaired) {
              historyRepaired = true;
              let fixed = this.repairToolCallHistory();
              // Providers that require opaque echo fields reject bare history.
              fixed += this.collapseToolHistoryWithoutPassthrough();
              spinner.stop();
              if (config.outputMode === "interactive") {
                console.log(
                  picocolors.yellow(
                    fixed > 0
                      ? `   Provider rejected the request (HTTP 400). Self-heal: repaired ${fixed} history item(s), retrying...`
                      : `   Provider rejected the request (HTTP 400). Self-heal: cleaned tool history for this provider, retrying...`,
                  ),
                );
              }
              await this.logger.logEvent("self_heal_tool_args_repair", {
                repaired: fixed,
                error: msg,
              });
              // Reset the transient-retry counter so the repaired request
              // gets its own retry budget; do NOT consume a slot for the
              // (pre-repair) failures since those were a different request.
              retries = 0;
              // Re-run with a clean stream accumulator so we don't double-
              // count partial tokens from the aborted attempt.
              assistantContent = "";
              firstStreamingToken = true;
              accumulatedToolCalls = {};
              streamFinishReason = undefined;
              spinner.start();
              continue;
            }
            retries++;
            // Fail fast on auth failures — retrying an expired session will not succeed and wastes time
            if (
              retries > maxRetries ||
              /401|unauthenticated|ACCESS_TOKEN_TYPE_UNSUPPORTED|gcloud auth|invalid_grant|invalid_rapt/i.test(
                msg,
              )
            ) {
              throw err;
            }
            const delay = Math.min(1000 * Math.pow(2, retries), 8000);
            spinner.stop();
            if (config.outputMode === "interactive") {
              // UX: print an HONEST label for the failure, not a blanket
              // "Connection failed". A request rejection (4xx/5xx), an auth
              // failure, and a network drop are different problems and the
              // user deserves to know which one is happening before we retry.
              const label = classifyModelError(msg);
              console.log(
                picocolors.yellow(
                  `   ${label} (attempt ${retries}/${maxRetries}), retrying in ${delay}ms...`,
                ),
              );
            }
            spinner.start();
            await new Promise((r) => setTimeout(r, delay));
            // Recreate the AbortController for the retry — the previous one
            // may have been aborted or nullified by abortActiveStream().
            this.activeAbortController = new AbortController();
          }
        }
      };

      try {
        await wrapModelCall(lifecycleCtx, runModel);
      } catch (err: any) {
        spinner.stop();
        // UX: honest final-error label. "Failed to connect to LLM server"
        // was wrong for 4xx/5xx/auth failures — the connection worked, the
        // request was rejected. Tell the user what actually happened.
        const label = classifyModelError(String(err?.message || ""));
        console.error(picocolors.red(`\n[ERROR] ${label}:\n  ${err.message}`));
        await this.logger.logEvent("api_error", { error: err.message });
        throw err;
      }
      spinner.stop();

      // ── Output Truncation Recovery (finish_reason: "length") ──────────
      // When the model hits max_output_tokens, the response is incomplete.
      // Two cases:
      //   1. Truncated mid-text (no tool calls): push the partial assistant
      //      message, inject a "continue" prompt, and re-enter the loop so
      //      the model picks up where it left off.
      //   2. Truncated mid-tool-call (partial JSON args): the tool call is
      //      malformed and cannot be executed. Retry the model call with
      //      doubled maxOutputTokens (capped at 32768) so the model has room
      //      to complete the tool call.
      if (streamFinishReason === "length" && truncationRetries < maxTruncationRetries) {
        truncationRetries++;
        const hasPartialToolCalls = Object.keys(accumulatedToolCalls).length > 0;

        if (hasPartialToolCalls) {
          // Case 2: truncated mid-tool-call. Retry with a larger output budget.
          const newMax = Math.min(adapterDefaults.maxOutputTokens * 2, 32768);
          if (config.outputMode === "interactive") {
            console.log(
              picocolors.yellow(
                `   Output truncated mid-tool-call (max_tokens=${adapterDefaults.maxOutputTokens}). Retrying with ${newMax} tokens...`,
              ),
            );
          }
          await this.logger.logEvent("truncation_recovery", {
            reason: "length",
            mode: "retry_with_doubled_max_tokens",
            oldMax: adapterDefaults.maxOutputTokens,
            newMax,
          });
          // Temporarily raise the output token limit for this retry.
          adapterDefaults.maxOutputTokens = newMax;
          // Reset accumulators and re-run the model with the same messages.
          assistantContent = "";
          firstStreamingToken = true;
          accumulatedToolCalls = {};
          streamFinishReason = undefined;
          spinner.start();
          try {
            await wrapModelCall(lifecycleCtx, runModel);
          } catch (err: any) {
            spinner.stop();
            throw err;
          }
          spinner.stop();
        } else {
          // Case 1: truncated mid-text. Push the partial message and inject
          // a continuation prompt so the model resumes from where it stopped.
          if (config.outputMode === "interactive") {
            console.log(
              picocolors.yellow(
                `   Output truncated (max_tokens=${adapterDefaults.maxOutputTokens}). Continuing...`,
              ),
            );
          }
          await this.logger.logEvent("truncation_recovery", {
            reason: "length",
            mode: "continue_prompt",
            maxTokens: adapterDefaults.maxOutputTokens,
          });
          // Push the partial assistant message as-is.
          const partialMsg: Message = {
            role: "assistant",
            content: assistantContent || "",
          };
          this.messages.push(partialMsg);
          await this.logger.logEvent("assistant_response", partialMsg);
          // Inject a continuation prompt — the model will see its own partial
          // output in history and pick up from the last sentence.
          this.messages.push({
            role: "user",
            content: "Continue from where you left off. Do not repeat what you already wrote.",
          });
          lastAssistantContent = assistantContent;
          // Re-enter the while(true) loop for the continuation turn.
          continue;
        }
      } else if (streamFinishReason === "length" && truncationRetries >= maxTruncationRetries) {
        // Exhausted truncation retries — proceed with whatever we have rather
        // than looping forever. The response may be incomplete.
        if (config.outputMode === "interactive") {
          console.log(
            picocolors.yellow(
              `   Output still truncated after ${maxTruncationRetries} retries. Proceeding with partial response.`,
            ),
          );
        }
        await this.logger.logEvent("truncation_recovery_exhausted", {
          reason: "length",
          retries: truncationRetries,
        });
      }

      const toolCalls: ToolCall[] = Object.keys(accumulatedToolCalls).map((key) => {
        const idx = parseInt(key, 10);
        const raw = accumulatedToolCalls[idx];
        // Self-Heal Layer A: sanitize arguments to valid JSON before they
        // enter history. A malformed arguments string here would be echoed
        // back to the provider on the next turn and trigger a permanent
        // HTTP 400 "invalid tool call arguments" that no amount of retrying
        // can fix — and would poison every subsequent prompt.
        const sanitizedArgs = this.sanitizeToolCallArguments(raw.arguments);
        return {
          id: raw.id || `call_${Date.now()}_${idx}`,
          type: "function" as const,
          function: {
            name: raw.name || "",
            arguments: sanitizedArgs,
          },
          ...(raw.passthrough ? { passthrough: raw.passthrough } : {}),
        };
      });

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

      // US-4.3: parse memory citations from the model output and bump hit
      // counts so decay + provenance tracking reflects what the model used.
      this.trackCitations(assistantContent).catch(() => {});

      if (toolCalls.length === 0) {
        // No more tool calls — the agent thinks it is done. But if the user
        // queued a mid-run intervention while this final answer was streaming,
        // don't drop it: re-enter the loop so the steering message is consumed
        // and the model gets another turn with the new instruction.
        if (this.intervention.hasPending()) {
          continue;
        }
        // US-AMBIENT: goal-loop + self-heal as a harness characteristic. When
        // the agent finishes a file-mutating task, the harness independently
        // verifies the codebase is healthy (tsc + tests). If it isn't, the
        // harness injects a self-heal directive and continues the loop — the
        // agent keeps working until the goal is genuinely verified complete,
        // not just until it says it is. Capped at ambientMaxHealRounds; non-
        // mutating turns (questions, read-only research) skip the gate.
        if ((mutatedThisTurn || ambientVerificationFailed) && this.ambient.isEnabled()) {
          if (!this.ambient.hasBudget()) {
            const message =
              "Ambient maker-checker verification did not approve the work " +
              `after ${config.ambientMaxHealRounds} bounded self-heal rounds. ` +
              "The goal is incomplete; inspect the last diagnostics before continuing.";
            ambientVerificationFailed = true;
            await this.logger.logEvent("ambient_verify_exhausted", {
              rounds: this.ambient.roundsUsed(),
              message,
            });
            if (config.outputMode === "interactive") {
              console.log(picocolors.red(`   ✗ ${message}`));
            }
            if (onEvent) {
              onEvent({
                type: "error",
                data: { error: message },
              });
            }
            break;
          }
          // Reuse the maker-checker primitive in FULL mode (single verification
          // pipeline — no parallel tsc/npm-test). changeHash ties the audit
          // entry to this completion check.
          const verify = await this.ambient.verify({
            changeHash: `${this.logger.getSessionId()}:ambient:${loopCount}`,
          });
          await this.logger.logEvent("ambient_verify", {
            healthy: verify.healthy,
            verdict: verify.verdict,
            total: verify.total,
            failed: verify.failed,
            failedChecks: verify.failedChecks,
            round: this.ambient.roundsUsed() + 1,
          });
          if (config.outputMode === "interactive") {
            if (verify.healthy) {
              console.log(
                picocolors.green(
                  `   ✓ Ambient verify: maker-checker APPROVED (${verify.total} acceptance criteria) — goal verified.`,
                ),
              );
            } else {
              console.log(
                picocolors.yellow(
                  `   Ambient verify: maker-checker ${verify.verdict.toUpperCase()} (${verify.failed}/${verify.total} failed) — self-heal round ${this.ambient.roundsUsed() + 1}/${config.ambientMaxHealRounds}.`,
                ),
              );
            }
          }
          if (!verify.healthy) {
            ambientVerificationFailed = true;
            this.ambient.spendRound();
            const directive = this.ambient.makeHealDirective(
              verify,
              this.ambient.roundsUsed(),
              config.ambientMaxHealRounds,
            );
            this.messages.push({ role: "user", content: directive });
            await this.logger.logEvent("ambient_heal_inject", {
              round: this.ambient.roundsUsed(),
            });
            if (onEvent) {
              onEvent({
                type: "intervention",
                data: { text: "[ambient self-heal]" },
              });
            }
            mutatedThisTurn = false; // re-earned by the heal turn's own edits
            continue;
          }
          ambientVerificationFailed = false;
        }
        break;
      }

      // Execute tool calls
      if (config.outputMode === "interactive") console.log("");

      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const toolName = call.function.name;
        const displayName = Agent.getToolDisplayName(toolName);
        let args: any = {};
        // Self-Heal: when the model emits malformed JSON arguments, capture the
        // real parse error so the diagnostic tells the model the truth
        // ("arguments were not valid JSON") instead of the misleading
        // "filePath: Required" that schema validation produces against an
        // empty `args = {}`. An accurate diagnostic is what lets the model
        // self-correct in the next turn instead of repeating the same malformed
        // call.
        let argsParseError: string | null = null;
        let rawArgsDebug = "";
        try {
          let rawArgs = call.function.arguments.trim();
          rawArgsDebug = rawArgs;
          // Strip triple backticks wrapper or json identifier if present
          if (rawArgs.startsWith("```")) {
            rawArgs = rawArgs
              .replace(/^```(?:json)?\n?/i, "")
              .replace(/\n?```$/, "")
              .trim();
          }
          args = JSON.parse(rawArgs);
        } catch (err: any) {
          // Args parsing failed — record the precise error for an accurate
          // diagnostic below; do NOT silently fall through to schema
          // validation, which would mislabel the cause.
          argsParseError = err?.message || String(err);
        }

        // Emit tool_call event for GUI
        if (onEvent) {
          onEvent({ type: "tool_call", data: { toolName, toolArgs: args } });
        }

        // Human-Approval Gate Check (centralized in agent, not duplicated in tools).
        // US-6.2: for run_command, approval is bound to the command's risk band
        // (destructive / privileged / network / secret-risk / exfiltration),
        // not just the tool name — so `ls` runs freely while `rm -rf /` prompts.
        // YOLO mode bypasses BOTH layers — tool-level and command risk classifier.
        let isApproved = true;
        // Classify command risk for run_command (US-6.2) — the classifier
        // determines the risk band and requiresApproval flag. needsApprovalFor()
        // then checks autonomy grants against the risk band.
        let commandRisk: string | undefined;
        let commandRequiresApproval = false;
        if (toolName === "run_command" && typeof args.command === "string") {
          const classification = classifyCommand(args.command);
          commandRisk = classification.risk;
          commandRequiresApproval = classification.requiresApproval;
        }
        const needsApproval = needsApprovalFor(toolName, commandRisk) || commandRequiresApproval;
        // Build the scoped approval-cache key for this action (US-6.4).
        const approvalKey: ApprovalKey = { toolName };
        if (toolName === "run_command" && commandRisk) {
          approvalKey.riskBand = commandRisk;
        } else if (
          (toolName === "write_file" ||
            toolName === "replace_content" ||
            toolName === "apply_patch") &&
          typeof args.filePath === "string"
        ) {
          // Cache by workspace-relative directory so "approve all writes under
          // src/" is a single grant, not per-file.
          try {
            approvalKey.dir = path.relative(process.cwd(), path.resolve(args.filePath)) || ".";
          } catch {
            approvalKey.dir = String(args.filePath);
          }
        } else if (toolName === "office_doc" && typeof args.file === "string") {
          // Scope office_doc approvals to the exact document file. One user
          // consent covers the whole build of THAT document (officecli emits
          // many small ops — create, add paragraph, set style… — for a single
          // "make me a docx" intent), so we don't spam N popups per document.
          // Security reasoning: the grant is bounded to a single file path the
          // user already saw and approved, inside the workspace (path policy
          // still applies to every op). It does not loosen approvals for other
          // files, file edits outside the workspace, commands, or web tools.
          try {
            approvalKey.dir =
              path.relative(process.cwd(), path.resolve(args.file)) || String(args.file);
          } catch {
            approvalKey.dir = String(args.file);
          }
        }
        if (config.dryRun) {
          isApproved = true;
        } else if (needsApproval && this.approvalCache.has(approvalKey)) {
          // Reuse a prior "all similar" approval — no re-prompt.
          isApproved = true;
        } else if (needsApproval) {
          // Emit approval event for GUI. For file-mutation tools, include the
          // current file content so the renderer can render a real before/after
          // diff (US-2.4) rather than a static placeholder.
          if (onEvent) {
            const approvalData: any = { toolName, toolArgs: args };
            const mutPath = args.filePath ? path.resolve(args.filePath) : "";
            if (mutPath && fsSync.existsSync(mutPath)) {
              try {
                approvalData.currentContent = fsSync.readFileSync(mutPath, "utf8");
              } catch {
                /* unreadable — omit */
              }
            }
            approvalData.proposedContent = args.content ?? args.newString ?? args.new_content ?? "";
            onEvent({ type: "approval", data: approvalData });
          }
          const decision = await askUserApproval(toolName, args);
          isApproved = decision.approved;
          this.pendingRevisionNote = decision.revisionNote;
          // Record a session-scoped approval so similar actions skip the gate.
          if (isApproved && decision.scope === "session") {
            this.approvalCache.record(approvalKey, "session");
          } else if (isApproved && toolName === "office_doc") {
            // A single "Allow" on an office_doc op auto-approves subsequent
            // office_doc ops on the SAME file (file-scoped key above): the
            // user consented to building that document, and each officecli op
            // is a sub-step of the same consented deliverable. Ops on any
            // other file — or any other tool — still prompt normally.
            this.approvalCache.record(approvalKey, "session");
          }
        }

        let result: any;
        if (config.dryRun) {
          result = `[DRY RUN] Would execute '${toolName}' with: ${JSON.stringify(args)}`;
          if (config.outputMode === "interactive") {
            statusLine("DRY", `Preview — ${displayName}`);
            console.log(formatDetails(toolName, args, theme().gray("  ")));
          }
        } else if (!isApproved) {
          const note = this.pendingRevisionNote;
          this.pendingRevisionNote = undefined;
          result = note
            ? `Error: Action '${toolName}' was denied by the user. Revision requested: ${note}`
            : `Error: Action '${toolName}' was denied by the user.`;
          console.log(picocolors.red(`  ✗ ${displayName} — declined by you`));
        } else {
          const keyArg = this.summarizeToolArgs(toolName, args);
          const argHint = keyArg ? picocolors.gray(` ${keyArg}`) : "";

          // ── Destructive Action Guard (US-6.1: hash-based read-before-write) ──
          // write_file/replace_content cannot run on a file that was never read
          // in this session, and the on-disk SHA-256 + mtimeMs must match what
          // was captured at read time (compare-and-swap). A mismatch means the
          // file changed underneath us — reject and force a re-read.
          const resolvedPath = args.filePath ? path.resolve(args.filePath) : "";
          let writeBlockedReason: string | null = null;
          if (
            (toolName === "write_file" ||
              toolName === "replace_content" ||
              toolName === "apply_patch") &&
            resolvedPath
          ) {
            try {
              const verify = await this.fileReadHistory.verifyBeforeWrite(resolvedPath);
              if (!verify.matches) writeBlockedReason = verify.reason || "file was not read first";
            } catch (e: any) {
              writeBlockedReason = e.message;
            }
          }

          if (writeBlockedReason) {
            result = `Error: Refusing to ${toolName === "write_file" ? "write to" : "edit"} '${args.filePath}' \u2014 ${writeBlockedReason}`;
            if (config.outputMode === "interactive") {
              process.stdout.write(
                `\r  ${picocolors.red("✗")} ${picocolors.gray(displayName)}${argHint} \u2014 read-before-write check failed\n`,
              );
            }
          } else {
            // Live progress for tool execution: replaces the old static ⟳
            // marker so long-running tools (tests, browser, research) show
            // elapsed time instead of a frozen line (Principle: Seeing).
            const toolSpinner = new Spinner(keyArg ? `${displayName} ${keyArg}` : displayName);
            toolSpinner.start();
            try {
              const tool = this.registry.getTool(toolName);
              if (!tool) {
                result = `Error: Action '${toolName}' is not available.`;
                toolSpinner.stop();
                if (config.outputMode === "interactive") {
                  process.stdout.write(
                    `\r  ${picocolors.red("✗")} ${picocolors.gray(displayName)} — not found\n`,
                  );
                }
              } else {
                // Self-Heal: short-circuit on malformed JSON args BEFORE schema
                // validation. Without this, `args = {}` flows into safeParse and
                // the model is told "filePath: Required" — a lie that hides the
                // real cause (its arguments weren't valid JSON) and prevents
                // self-correction. The diagnostic includes the raw arguments
                // preview + the parser error so the model can fix the JSON.
                if (argsParseError) {
                  const preview =
                    rawArgsDebug.length > 300 ? rawArgsDebug.slice(0, 297) + "..." : rawArgsDebug;
                  result = formatDiagnosticBlock(
                    createDiagnosticBlock(
                      toolName,
                      { rawArguments: preview },
                      new Error(
                        `Malformed tool-call arguments (not valid JSON): ${argsParseError}. Re-emit the call with valid JSON matching the tool's schema.`,
                      ),
                    ),
                  );
                  toolSpinner.stop();
                  if (config.outputMode === "interactive") {
                    statusLine(
                      "ERROR",
                      `${displayName} rejected malformed JSON args — ${argsParseError}`,
                    );
                  }
                  await this.logger.logEvent("tool_args_malformed_json", {
                    tool: toolName,
                    error: argsParseError,
                    raw: preview,
                  });
                  // Skip execution entirely; fall to result handling below.
                } else {
                  // US-6.3: only retry-safe (read-only/idempotent) tools are
                  // auto-retried on transient failure. Destructive/shell tools
                  // execute exactly once so a transient blip can never repeat a
                  // state-changing action.
                  const retrySafe = isRetrySafe(toolName);
                  const maxAttempts = retrySafe ? 3 : 1;
                  let attempt = 0;
                  let lastErr: any = null;
                  while (true) {
                    try {
                      // US-9.4 / US-13.4: validate the model's tool-call arguments against
                      // the tool's Zod schema BEFORE executing. Model text is unverified —
                      // never run a tool on unvalidated args (a missing required field
                      // previously produced "○ undefined" todo items). A validation
                      // failure becomes a structured diagnostic returned to the model so
                      // it can self-correct next turn, instead of executing with gaps.
                      const parsedArgs = tool.parameters.safeParse(args);
                      if (!parsedArgs.success) {
                        const issues = parsedArgs.error.issues
                          .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
                          .join("; ");
                        result = formatDiagnosticBlock(
                          createDiagnosticBlock(
                            toolName,
                            args,
                            new Error(`Invalid tool arguments: ${issues}`),
                          ),
                        );
                        if (config.outputMode === "interactive") {
                          toolSpinner.stop();
                          statusLine("ERROR", `${displayName} rejected invalid args — ${issues}`);
                        }
                        break; // do not execute; do not retry a schema failure
                      }
                      args = parsedArgs.data; // apply defaults + strip unknown keys
                      // US-15.1: route the tool call through the lifecycle interception
                      // engine (wrap_tool_call) so the provenance audit hook — and the
                      // opt-in maker-checker gate — actually fire in the real loop.
                      const toolCtx: LifecycleContext = {
                        ...lifecycleCtx,
                        toolCall: { name: toolName, args },
                        metadata: {
                          changeHash: `${this.logger.getSessionId()}:${loopCount}:${toolName}:${i}`,
                        },
                      };
                      const invokeTool = () =>
                        wrapToolCall(toolCtx, async () => {
                          // Route network/research tools through the bound
                          // ProductionRuntime IntegrationBroker (§9). Local tools
                          // still execute directly.
                          const { invokeUnderRuntime, getBoundProductionRuntime } =
                            await import("./harness/runtime-binding.js");
                          const rt = getBoundProductionRuntime();
                          if (
                            rt ||
                            [
                              "web_search",
                              "scrape_url",
                              "deep_research",
                              "find_all",
                              "entity_search",
                            ].includes(toolName)
                          ) {
                            const r = await invokeUnderRuntime(toolName, args, () =>
                              tool.execute(args),
                            );
                            if (!r.ok)
                              throw new Error(
                                r.error || `Tool '${toolName}' denied by runtime policy`,
                              );
                            return r.output;
                          }
                          return tool.execute(args);
                        });
                      result =
                        toolName === "evidence"
                          ? await withEvidenceTracker(this.evidenceTracker, invokeTool)
                          : await invokeTool();
                      this.tokenStats.toolCalls++;
                      // US-AMBIENT: remember that this turn changed files so the
                      // completion-gate verifier knows to run a health check.
                      // Office mutations count: building the deliverable is the
                      // flagship act — a document-only turn must not skip the
                      // completion gate that a code edit would trigger.
                      if (
                        toolName === "write_file" ||
                        toolName === "replace_content" ||
                        toolName === "apply_patch" ||
                        (toolName === "office_doc" &&
                          !["get", "view", "query", "validate", "help", "close"].includes(
                            String(args?.action || ""),
                          ))
                      ) {
                        mutatedThisTurn = true;
                      }

                      if (toolName === "view_file" && args.filePath) {
                        // US-6.1: record canonical path + SHA-256 + mtimeMs for
                        // compare-and-swap verification on the next write.
                        await this.fileReadHistory
                          .recordRead(path.resolve(args.filePath))
                          .catch(() => {});
                      }

                      toolSpinner.stop();
                      if (config.outputMode === "interactive") {
                        const { success } = await import("./cli_ui.js");
                        success(`${displayName}${argHint}`);
                        const preview = this.summarizeResult(result);
                        if (preview) {
                          process.stdout.write(picocolors.gray(`    → ${preview}\n`));
                        }
                      }
                      // US-13.4: success resets the consecutive-failure loop detector.
                      this.failureTracker.reset();
                      lastErr = null;
                      break;
                    } catch (error: any) {
                      lastErr = error;
                      attempt++;
                      if (attempt >= maxAttempts || !retrySafe) break;
                      await new Promise((r) =>
                        setTimeout(r, calculateBackoffWithJitter(attempt - 1)),
                      );
                    }
                  }
                  if (lastErr) {
                    // US-13.4: structured diagnostics + consecutive-failure loop
                    // detection. Three identical failures on the same tool pause and
                    // alert the user so the agent never silently thrashes.
                    const stuck = this.failureTracker.recordFailure(toolName, lastErr);
                    const diag = createDiagnosticBlock(toolName, args, lastErr);
                    result = `Error performing action: ${lastErr.message}\n${formatDiagnosticBlock(diag)}`;
                    if (config.outputMode === "interactive") {
                      toolSpinner.stop();
                      const { error } = await import("./cli_ui.js");
                      error(
                        `${displayName} — ${lastErr.message.length > 200 ? lastErr.message.slice(0, 197) + "…" : lastErr.message}`,
                      );
                      if (stuck) {
                        const { warn } = await import("./cli_ui.js");
                        warn(
                          `Detected ${this.failureTracker.maxConsecutiveFailures} identical failures of '${toolName}'. Pausing — the same action keeps failing. Reconsider the approach or fix the underlying cause.`,
                        );
                      }
                    }
                    await this.logger.logEvent("tool_failure_diagnostic", diag);
                  }
                } // end (no argsParseError) branch
              } // end tool-exists branch
            } finally {
              toolSpinner.stop();
            }
          } // end destructive action guard
        }

        const resultStr = typeof result === "string" ? result : safeStringify(result);

        // Process [File: path] markers in tool results (e.g. from pdf_read).
        // Converts image markers into vision content parts so the model can
        // "see" rendered PDF pages, screenshots, etc. — same mechanism as
        // user input image markers, but applied to tool output.
        let toolContent: Message["content"] = resultStr;
        if (typeof resultStr === "string" && resultStr.includes("[File:")) {
          try {
            toolContent = await processFileMarkers(resultStr);
          } catch {
            // If image processing fails, fall back to plain text
            toolContent = resultStr;
          }
        }

        const toolMsg: Message = {
          role: "tool",
          content: toolContent,
          name: toolName,
          tool_call_id: call.id,
        };

        this.messages.push(toolMsg);
        this.tokenStats.inputTokens += this.estimateTokens(
          typeof toolMsg.content === "string"
            ? toolMsg.content
            : JSON.stringify(toolMsg.content || ""),
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
              toolArgs: args,
              toolResult: resultStr,
            },
          });
        }

        // S11 / SPEC §16 / §11.3: When the evidence tool finalizes, log
        // provenance to the audit chain so the trail records what context
        // and sources produced each deliverable.
        if (toolName === "evidence" && args.action === "finalize") {
          try {
            const evResult = JSON.parse(resultStr);
            if (evResult.ok && evResult.docPath) {
              this.logger.logEvidenceProvenance({
                deliverablePath: evResult.docPath,
                sourceIds: (evResult.sources || []).map((s: any) => s.source_id),
                sourceRefs: (evResult.sources || []).map(
                  (s: any) => s.location?.description || s.title || s.source_id,
                ),
                contextUsed: (evResult.claims || [])
                  .map((c: any) => c.claim_text || c.rendered_text || "")
                  .join("; ")
                  .slice(0, 500),
                evidenceRef: evResult.evidencePath,
              });
              // Deliverable card — the proud acceptance moment (user-stories S7).
              // The old TUI was silent here; nothing told the user the document
              // was ready. Now a calm card announces it with the counts that
              // lead into Moment 5 (verification).
              if (config.outputMode === "interactive") {
                try {
                  const { card } = await import("./cli_ui.js");
                  const srcN = (evResult.sources || []).length;
                  const claimN = (evResult.claims || []).length;
                  const flaggedN = (evResult.claims || []).filter(
                    (c: any) => c.review_status === "flagged" || c.relationship === "unresolved",
                  ).length;
                  card({
                    title: "Deliverable ready",
                    body: [
                      `${evResult.docPath}`,
                      `${srcN} sources · ${claimN} claims · ${flaggedN} flagged for review`,
                      evResult.evidencePath ? `Evidence: ${evResult.evidencePath}` : "",
                    ].filter(Boolean),
                    footer:
                      "Provenance logged to the audit chain. Draft for review until a professional signs off.",
                    accent: "success",
                  });
                } catch {
                  // card() must never break the agent loop.
                }
              }
              // Start the next document with a clean session-owned tracker.
              this.evidenceTracker.reset();
            }
          } catch {
            // Result wasn't structured JSON — skip provenance logging
          }
        }
      }

      if (config.outputMode === "interactive") {
        console.log("");
      }
    }

    // US-13.2: write a tamper-evident checkpoint after every turn so a crash
    // can be detected and resumed on the next launch (crash recovery).
    await this.writeCheckpoint().catch(() => {});

    // Auto-save session state after each prompt completes (sync for reliability)
    this.saveSessionStateSync();

    // US-4.2: background memory extraction -> pending review queue (fire-and-forget).
    this.maybeExtractMemory().catch(() => {});

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
