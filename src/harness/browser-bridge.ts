/**
 * Browser bridge — the loopback-daemon equivalent of the Electron preload's
 * `window.quiver` API (Phase 8, ADR-009).
 *
 * The browser UI (the restored three-plane workspace) speaks the SAME API the
 * Electron renderer did, but over the daemon's HTTP/SSE endpoints instead of
 * Electron IPC. This module:
 *   - constructs the real Agent (registry + config + provider) on startAgent;
 *   - installs a prompt resolver so approvals/consent/main input surface to
 *     the browser and await the user's response (no readline in the daemon);
 *   - forwards every AgentEvent (tokens, tool calls, approvals, consent gate,
 *     compaction, sensitivity, done) to the browser via an SSE event bus;
 *   - exposes the memory/session/skill/config/evidence/review surfaces the
 *     renderer calls.
 *
 * The browser shim (src/harness/ui/js/bridge.js) calls these as fetch/SSE and
 * presents the same `api` object to the renderer modules.
 */

import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { getProjectRoot, getProjectSessionsDir } from "../paths.js";
import type { IncomingMessage, ServerResponse } from "http";

/**
 * Constrain a browser-supplied path to a canonical project directory (§16).
 * The browser must not pass arbitrary filesystem paths; this resolves the
 * requested path and rejects it unless it is inside the allowed dir. Returns
 * the safe absolute path or throws.
 */
function confineToDir(dir: string, requested: string): string {
  const safe = path.resolve(dir);
  const full = path.resolve(safe, requested);
  if (!full.startsWith(safe + path.sep) && full !== safe) {
    throw new Error(`forbidden: path '${requested}' is outside the allowed directory`);
  }
  return full;
}

/** Constrain to the project sessions directory (for load/delete session). */
function confineSessionPath(filePath: string): string {
  return confineToDir(getProjectSessionsDir(), filePath);
}

/** Constrain to the project root (for preview/open of deliverables). */
function confineProjectPath(filePath: string): string {
  return confineToDir(getProjectRoot(), filePath);
}

// ─── SSE event bus ────────────────────────────────────────────────────
// A single browser client subscribes to /api/agent/events (SSE). Agent events
// + prompt requests are pushed here. The prompt resolver awaits a matching
// response posted to /api/agent/respond.

type BusEvent =
  | { kind: "agent_event"; event: unknown }
  | { kind: "agent_token"; token: string }
  | { kind: "agent_raw"; data: unknown }
  | { kind: "prompt_request"; id: number; prompt: string; promptKind: string }
  | { kind: "agent_exit"; data: unknown }
  | { kind: "agent_error"; data: unknown };

class EventBus {
  private clients = new Set<ServerResponse>();
  history: BusEvent[] = []; // buffered for late subscribers (best-effort, capped)

  addClient(res: ServerResponse): void {
    this.clients.add(res);
  }
  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
  }
  emit(ev: BusEvent): void {
    this.history.push(ev);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    for (const c of this.clients) {
      try {
        c.write(`event: ${ev.kind}\n`);
        c.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        /* client gone */
      }
    }
  }
}

// ─── Pending prompt responses (browser → agent) ──────────────────────
const pendingResponses = new Map<number, (answer: string | null) => void>();
let promptSeq = 0;

// ─── The agent + bus singletons ──────────────────────────────────────
let agent: any = null;
let chatEngine: import("./interfaces.js").ExecutionEngine | null = null;
const bus = new EventBus();

/** Mirror of the CLI's turn-refusal classification (consent/sensitivity). */
function isTurnRefusalEvent(event: { type?: string; data?: any }): boolean {
  if (!event || typeof event !== "object") return false;
  if (event.type === "sensitivity_refused") return true;
  if (event.type === "consent_declined" || event.type === "consent_exclude") return true;
  if (event.type === "done") {
    const d = event.data || {};
    if (d.refused === true) return true;
    if (d.consent === "decline" || d.consent === "exclude") return true;
  }
  return false;
}

/** Resolve a pending prompt (called by /api/agent/respond). */
export function resolvePrompt(id: number, answer: string | null): boolean {
  const fn = pendingResponses.get(id);
  if (!fn) return false;
  pendingResponses.delete(id);
  fn(answer);
  return true;
}

/** Subscribe a browser client to the SSE stream. Returns the history replay. */
export function subscribe(res: ServerResponse): BusEvent[] {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  bus.addClient(res);
  res.on("close", () => bus.removeClient(res));
  return bus.history.slice(-50);
}

// ─── The window.quiver-equivalent API (called by the daemon routes) ───

export async function loadConfig(): Promise<any> {
  const { config } = await import("../config.js");
  return {
    provider: {
      modelName:
        config.openRouterModelProfile === "auto" ? "model chosen by workflow" : config.llmModelName,
      baseUrl: config.llmBaseUrl || (config.openRouterApiKey ? "https://openrouter.ai/api/v1" : ""),
    },
    autonomyGrants: config.autonomyGrants?.size ? [...config.autonomyGrants].join(",") : "",
    memory: { reviewQueue: true },
    // Settings surface (browser build): the workspace is fixed at launch and
    // shown read-only; credentials report stored/not-stored, never values.
    workspacePath: process.cwd(),
    checkerModelName: config.checkerModelName || "",
    maxContextTokens: config.maxContextTokens,
    consentGateEnabled: config.consentGateEnabled === true,
    sessionLogEnabled: config.sessionLogEnabled !== false,
    sessionLogMaxChars: config.sessionLogMaxChars,
    credentials: {
      llmApiKeyStored: Boolean(config.llmApiKey || config.openRouterApiKey),
      parallelApiKeyStored: Boolean(config.parallelApiKey),
    },
  };
}

export async function isConfigured(): Promise<boolean> {
  const { config } = await import("../config.js");
  // OpenRouter is a first-class cloud config; do not require the legacy
  // LLM_API_KEY/BASE_URL pair when OPENROUTER_API_KEY is present.
  return Boolean(
    (config.openRouterApiKey && config.openRouterModelProfile) ||
    config.llmApiKey ||
    config.llmBaseUrl,
  );
}

// ─── Config persistence (Settings / onboarding save path) ──────────────
//
// Non-secret settings persist as env assignments in the same .env file
// config.ts reads (CWD first, then walk-up; created 0600 when absent) and are
// applied to the live config so a save takes effect without a restart.
// Secrets NEVER pass through this path — they go to the OS credential store
// via /api/config/setCredential (US-1.3: never silently write a plaintext key).

const ENV_KEY_ALLOWLIST = new Set([
  "LLM_MODEL_NAME",
  "LLM_API_BASE_URL",
  "CHECKER_LLM_MODEL_NAME",
  "QUIVER_MAX_CONTEXT_TOKENS",
  "QUIVER_AUTONOMY",
  "QUIVER_CONSENT_GATE",
  "QUIVER_SESSION_LOG",
  "QUIVER_SESSION_LOG_MAX_CHARS",
]);

const CREDENTIAL_KEY_ALLOWLIST = new Set(["LLM_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY"]);

function resolveEnvFilePath(): string {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), ".env");
}

function updateEnvFile(assignments: Record<string, string>): void {
  const envPath = resolveEnvFilePath();
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = existing.length > 0 ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(assignments));
  const updated = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) updated.push(`${key}=${value}`);
  const body = updated.join("\n").replace(/\n*$/, "\n");
  fs.writeFileSync(envPath, body, { mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // best effort on platforms without POSIX modes
  }
}

/** Persist + live-apply non-secret settings from the Settings/onboarding UI. */
export async function saveConfig(cfg: any): Promise<{ saved: boolean; error?: string }> {
  if (!cfg || typeof cfg !== "object") return { saved: false, error: "no settings provided" };
  const { config, applyTrustTier, ALL_GRANTS } = await import("../config.js");

  const assignments: Record<string, string> = {};
  const cleanString = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    // Values never span lines; a newline here is an injection attempt.
    if (/[\r\n]/.test(trimmed)) return undefined;
    return trimmed;
  };

  const modelName = cleanString(cfg.provider?.modelName);
  // "model chosen by workflow" is the display alias for profile-auto — never persist it.
  if (modelName !== undefined && modelName !== "model chosen by workflow") {
    assignments.LLM_MODEL_NAME = modelName;
    config.llmModelName = modelName;
  }
  const baseUrl = cleanString(cfg.provider?.baseUrl);
  if (baseUrl !== undefined && baseUrl !== "https://openrouter.ai/api/v1") {
    assignments.LLM_API_BASE_URL = baseUrl;
    config.llmBaseUrl = baseUrl;
  }
  const checkerModelName = cleanString(cfg.checkerModelName);
  if (checkerModelName !== undefined) {
    assignments.CHECKER_LLM_MODEL_NAME = checkerModelName;
    config.checkerModelName = checkerModelName;
  }
  const maxContext = Number(cfg.maxContextTokens);
  if (Number.isFinite(maxContext) && maxContext >= 1_000) {
    assignments.QUIVER_MAX_CONTEXT_TOKENS = String(Math.floor(maxContext));
    config.maxContextTokens = Math.floor(maxContext);
  }
  if (typeof cfg.consentGateEnabled === "boolean") {
    assignments.QUIVER_CONSENT_GATE = cfg.consentGateEnabled ? "1" : "0";
    config.consentGateEnabled = cfg.consentGateEnabled;
  }
  if (typeof cfg.sessionLogEnabled === "boolean") {
    assignments.QUIVER_SESSION_LOG = cfg.sessionLogEnabled ? "1" : "0";
    config.sessionLogEnabled = cfg.sessionLogEnabled;
  }
  const logMax = Number(cfg.sessionLogMaxChars);
  if (Number.isFinite(logMax) && logMax > 0) {
    assignments.QUIVER_SESSION_LOG_MAX_CHARS = String(Math.floor(logMax));
    config.sessionLogMaxChars = Math.floor(logMax);
  }
  const grants = cleanString(cfg.autonomyGrants);
  if (grants !== undefined) {
    assignments.QUIVER_AUTONOMY = grants;
    const parts = grants.split(",").map((s) => s.trim()).filter(Boolean);
    const tierPart = parts.find((p) => p.startsWith("tier:"));
    if (tierPart) {
      applyTrustTier(tierPart.slice("tier:".length) as any);
    } else {
      applyTrustTier(null);
    }
    for (const part of parts) {
      if (part.startsWith("tier:")) continue;
      if ((ALL_GRANTS as readonly string[]).includes(part)) {
        config.autonomyGrants.add(part as any);
      }
    }
    config.browserHeadless = !config.autonomyGrants.has("browser:visible");
  }

  // Refuse to persist anything secret-shaped; secrets go to the credential store.
  for (const key of Object.keys(assignments)) {
    if (!ENV_KEY_ALLOWLIST.has(key)) delete assignments[key];
  }

  try {
    if (Object.keys(assignments).length > 0) updateEnvFile(assignments);
    return { saved: true };
  } catch (err: any) {
    return { saved: false, error: `could not persist settings: ${err?.message ?? err}` };
  }
}

/** Store a provider credential in the OS credential store (never plaintext). */
export async function setCredentialForUi(key: string, value: string): Promise<{ ok: boolean }> {
  if (!CREDENTIAL_KEY_ALLOWLIST.has(key) || typeof value !== "string" || value.trim().length === 0) {
    return { ok: false };
  }
  const { setCredential } = await import("../secrets/keychain.js");
  const stored = await setCredential(key, value.trim());
  if (!stored) return { ok: false };
  // Live-apply so onboarding can start the agent without a restart.
  const { config } = await import("../config.js");
  if (key === "LLM_API_KEY") config.llmApiKey = value.trim();
  if (key === "OPENROUTER_API_KEY") config.openRouterApiKey = value.trim();
  if (key === "PARALLEL_API_KEY") config.parallelApiKey = value.trim();
  return { ok: true };
}

export async function startAgent(_config: any, _resumeLatest: boolean): Promise<void> {
  if (agent) return;
  const { getBoundProductionRuntime } = await import("./runtime-binding.js");
  const runtime = getBoundProductionRuntime();
  // Prefer the bound ProductionRuntime's network guard + tool removals. If the
  // browser UI was started without a runtime (tests), fall back to installing
  // the guard from the deployment profile directly.
  const { resolveDeploymentProfile, installNetworkGuard, profileConfig } =
    await import("../security/execution_context.js");
  const profile = runtime?.deploymentProfile ?? resolveDeploymentProfile();
  installNetworkGuard(profile);
  const { globalRegistry } = await import("../registry.js");
  await globalRegistry.loadAll();
  for (const name of profileConfig(profile).removedTools) {
    globalRegistry.unregisterTool(name);
  }
  const { Agent } = await import("../agent.js");
  agent = new Agent(globalRegistry);
  // Chat turns run as GoalContracts on the production ExecutionEngine — the
  // same control plane as workflow runs (checkpoints, traces, honest
  // outcomes). The conversational loop is delegated as the turn executor;
  // its consent/approval gates still run inline via the prompt resolver.
  if (runtime) {
    chatEngine = runtime.createChatEngine(async (contract, io) => {
      let refused = false;
      await agent.prompt(
        contract.objective,
        (token: string) => io.onToken?.(token),
        (event: any) => {
          if (isTurnRefusalEvent(event)) refused = true;
          io.onEvent?.(event);
        },
      );
      return { content: "", refused };
    });
  }
  // Install the prompt resolver: every approval/consent/main-input prompt is
  // forwarded to the browser and the answer is awaited.
  const { setPromptResolver } = await import("../utils/prompt.js");
  setPromptResolver(async (prompt, kind) => {
    const id = ++promptSeq;
    bus.emit({ kind: "prompt_request", id, prompt, promptKind: kind });
    return new Promise<string | null>((resolve) => {
      pendingResponses.set(id, resolve);
      // Fail closed after 5 minutes (no silent hang).
      setTimeout(
        () => {
          if (pendingResponses.has(id)) {
            pendingResponses.delete(id);
            resolve(null);
          }
        },
        5 * 60 * 1000,
      );
    });
  });
}

export async function sendToAgent(text: string): Promise<void> {
  if (!agent) await startAgent({}, false);
  // Run the turn asynchronously; tokens + events flow over SSE. When the
  // production runtime is bound, the turn is a durable engine run (chat as
  // GoalContract); the direct prompt path remains only for runtimes that
  // predate the binding (tests).
  void (async () => {
    try {
      if (chatEngine) {
        const runId = `CHAT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const { getBoundProductionRuntime } = await import("./runtime-binding.js");
        const rt = getBoundProductionRuntime();
        const outcome = await chatEngine.run(
          {
            runId,
            objective: text,
            requiredDeliverables: [],
            definitionOfDone: [],
            requiredSourceCategories: [],
            dataSensitivity: "confidential-internal",
            reviewer: "local-operator",
            budgets: { iterations: 1 },
            stopConditions: [],
            createdAt: new Date().toISOString(),
          },
          {
            trace: rt?.traces,
            turnIo: {
              onToken: (token: string) => bus.emit({ kind: "agent_token", token }),
              onEvent: (event: unknown) => bus.emit({ kind: "agent_event", event }),
            },
          } as any,
        );
        bus.emit({
          kind: "agent_event",
          event: {
            type: "done",
            data: { runId, status: outcome.status, stopReason: outcome.stopReason },
          },
        });
        return;
      }
      await agent.prompt(
        text,
        (token: string) => bus.emit({ kind: "agent_token", token }),
        (event: unknown) => bus.emit({ kind: "agent_event", event }),
      );
      bus.emit({ kind: "agent_event", event: { type: "done", data: {} } });
    } catch (err: any) {
      bus.emit({ kind: "agent_error", data: { error: String(err?.message || err) } });
    }
  })();
}

export async function approveToolCall(
  _approve: boolean,
  _note?: string,
): Promise<{ ok: boolean; via: string }> {
  // Approvals are resolved via /api/agent/respond (prompt resolver). This
  // endpoint is retained for API parity but must not pretend it approved anything.
  if (pendingResponses.size === 0) {
    return { ok: false, via: "noop — no pending approval prompt; use /api/agent/respond" };
  }
  const ans = _approve ? "y" : "n";
  for (const [id] of pendingResponses) {
    resolvePrompt(id, ans);
    return { ok: true, via: "prompt-resolver" };
  }
  return { ok: false, via: "noop" };
}

export async function consentRespond(decision: "approve" | "decline" | "exclude"): Promise<void> {
  // Consent resolves the pending consent prompt. Map to a prompt answer.
  const ans = decision === "approve" ? "y" : "n";
  // Resolve the most recent pending prompt of kind "question"/"question-raw".
  for (const [id] of pendingResponses) {
    resolvePrompt(id, ans);
    return;
  }
}

export async function stopAgent(): Promise<void> {
  if (!agent) return;
  agent.abortActiveStream?.();
}

// ── Sessions ─────────────────────────────────────────────────────────
export async function listSessions(): Promise<any[]> {
  const { listSessions: ls } = await import("../session/schema.js");
  return ls();
}
export async function loadSession(filePath: string): Promise<any> {
  if (!agent) await startAgent({}, false);
  const safe = confineSessionPath(filePath);
  await agent.loadSessionState?.(safe);
  return { loaded: true };
}
export async function deleteSession(filePath: string): Promise<void> {
  const safe = confineSessionPath(filePath);
  try {
    fs.rmSync(safe, { force: true });
  } catch {
    /* ignore */
  }
}

// ── Memory files (persona/project .txt) ──────────────────────────────
export async function listMemory(): Promise<any[]> {
  const { getProjectMemoryDir } = await import("../paths.js");
  const dir = getProjectMemoryDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /\.(txt|md)$/i.test(n))
    .map((name) => {
      const p = path.join(dir, name);
      const stat = fs.statSync(p);
      return { name, content: fs.readFileSync(p, "utf8"), size: stat.size, mtime: stat.mtimeMs };
    });
}
export async function saveMemory(name: string, content: string): Promise<void> {
  const { getProjectMemoryDir } = await import("../paths.js");
  const dir = getProjectMemoryDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, path.basename(name)), content);
}
export async function deleteMemory(name: string): Promise<void> {
  const { getProjectMemoryDir } = await import("../paths.js");
  try {
    fs.rmSync(path.join(getProjectMemoryDir(), path.basename(name)), { force: true });
  } catch {
    /* ignore */
  }
}

// ── Core memory (identity/human/project) ─────────────────────────────
export async function loadCoreMemory(): Promise<any> {
  const { loadCoreMemory: l } = await import("../state.js");
  return l();
}
export async function saveCoreMemory(core: any): Promise<void> {
  const { saveCoreMemory: s } = await import("../state.js");
  await s(core);
}

// ── Memory review queue (principles §1 — pending facts) ──────────────
export async function memoryReviewList(): Promise<any[]> {
  const { readPendingMemoryFacts } = await import("../memory/schema.js");
  return readPendingMemoryFacts();
}
export async function memoryReviewAction(
  factId: string,
  action: string,
  content: string,
): Promise<void> {
  const { acceptMemoryFact, deleteMemoryFact, updateMemoryFact } =
    await import("../memory/schema.js");
  if (action === "accept") await acceptMemoryFact(factId);
  else if (action === "reject" || action === "expire") await deleteMemoryFact(factId);
  else if (action === "edit") await updateMemoryFact?.(factId, { content } as any);
}

// ── Context rail exclude/veto (principles §2) ────────────────────────
export async function excludeFromRun(
  memoryName: string,
): Promise<{ ok: boolean; excluded?: string; error?: string }> {
  if (!memoryName || typeof memoryName !== "string") {
    return { ok: false, error: "memoryName required" };
  }
  if (!agent) {
    return { ok: false, error: "agent not started — exclusion not applied" };
  }
  // Best-effort: set on agent if it exposes excludedMemories; otherwise honest fail.
  if (typeof agent.excludeMemory === "function") {
    await agent.excludeMemory(memoryName);
    return { ok: true, excluded: memoryName };
  }
  if (Array.isArray(agent.excludedMemories)) {
    if (!agent.excludedMemories.includes(memoryName)) agent.excludedMemories.push(memoryName);
    return { ok: true, excluded: memoryName };
  }
  return {
    ok: false,
    error:
      "exclusion surface not available on this agent build — use the context consent gate instead",
  };
}

// ── Skills ───────────────────────────────────────────────────────────
export async function listSkills(): Promise<any[]> {
  const { getSkillsDir } = await import("../paths.js");
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, name: e.name }));
}
export async function readSkill(skillName: string): Promise<string> {
  const { getSkillsDir } = await import("../paths.js");
  const f = path.join(getSkillsDir(), skillName, "SKILL.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}
export async function saveSkill(skillName: string, content: string): Promise<void> {
  const { getSkillsDir } = await import("../paths.js");
  const dir = path.join(getSkillsDir(), skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
}

// ── Attachments (S3 — hand it your mess) ────────────────────────────
// Browser File objects carry no filesystem path, so the UI uploads dropped /
// picked files here; the daemon stages them inside the workspace and returns
// a real path the agent turns into a NATIVE model file part via the
// `[File: path]` marker pipeline (src/file_encoder.ts). Never a text-only
// "read this path" instruction.

/** Extensions the browser may stage for native model attachment. */
const ATTACHABLE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "txt",
  "md",
  "json",
]);

/** Matches MAX_IMAGE_SIZE in file_encoder.ts — the encode step refuses more. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export async function stageAttachment(input: {
  name?: string;
  dataBase64?: string;
}): Promise<{ path?: string; name?: string; size?: number; error?: string }> {
  const rawName = String(input?.name ?? "");
  const name = path.basename(rawName).replace(/[^\w.\- ()\[\]]/g, "_");
  if (!name) return { error: "attachment is missing a file name" };
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!ATTACHABLE_EXTENSIONS.has(ext)) {
    return {
      error: `unsupported attachment type '.${ext}' — supported: images, PDF, Word, Excel, PowerPoint, CSV, text, Markdown, JSON`,
    };
  }
  const b64 = String(input?.dataBase64 ?? "");
  if (!b64) return { error: "attachment payload is empty" };
  let data: Buffer;
  try {
    data = Buffer.from(b64, "base64");
  } catch {
    return { error: "attachment payload is not valid base64" };
  }
  if (data.length === 0) return { error: "attachment is empty (0 bytes)" };
  if (data.length > MAX_ATTACHMENT_BYTES) {
    return {
      error: `attachment is ${(data.length / 1024 / 1024).toFixed(1)}MB — the native-attachment limit is 20MB`,
    };
  }
  const dir = path.join(getProjectRoot(), ".quiver", "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`);
  const { atomicWrite } = await import("../fs/atomic_write.js");
  await atomicWrite(staged, data);
  return { path: staged, name, size: data.length };
}

// ── Preview / deliverables ───────────────────────────────────────────
export async function previewFile(filePath: string): Promise<any> {
  const safe = confineProjectPath(filePath);
  if (!fs.existsSync(safe)) return { error: "not found" };
  const buf = fs.readFileSync(safe);
  const ext = path.extname(safe).toLowerCase();
  const type = [".docx", ".xlsx", ".pptx"].includes(ext)
    ? "office"
    : ext === ".pdf"
      ? "pdf"
      : "text";
  return { type, name: path.basename(safe), content: buf.toString("utf8").slice(0, 20000) };
}
export async function openFile(filePath: string): Promise<void> {
  const safe = confineProjectPath(filePath);
  const { spawn } = await import("child_process");
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "" : "xdg-open";
  if (cmd)
    try {
      spawn(cmd, [safe], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* ignore */
    }
}
export async function showInFolder(filePath: string): Promise<void> {
  const { spawn } = await import("child_process");
  if (process.platform === "darwin")
    try {
      spawn("open", ["-R", filePath], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* ignore */
    }
  else if (process.platform === "win32")
    try {
      spawn("explorer", ["/select,", filePath], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* ignore */
    }
}

// ── Evidence lineage (principles §3) ─────────────────────────────────
export async function loadEvidence(docFilePath: string): Promise<any> {
  const base = docFilePath.replace(/\.(docx|xlsx|pptx)$/i, "");
  const evidencePath = `${base}_Evidence.json`;
  const runRecordPath = `${base}_Run_Record.json`;
  const out: any = {};
  if (fs.existsSync(evidencePath)) out.evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  if (fs.existsSync(runRecordPath))
    out.runRecord = JSON.parse(fs.readFileSync(runRecordPath, "utf8"));
  return out;
}

// ── Review flow (SPEC §8.3) ──────────────────────────────────────────
export async function reviewMarkFinal(
  filePath: string,
  _openFlags: number,
  _figureStatuses?: any[],
): Promise<any> {
  const { AuditChain } = await import("../audit_chain.js");
  const chain = new AuditChain();
  chain.appendEntry(
    "evidence",
    JSON.stringify({ filePath, action: "markFinal", openFlags: _openFlags }),
  );
  return { marked: true };
}
export async function reviewOverride(
  filePath: string,
  _openFlags: number,
  _figureStatuses?: any[],
): Promise<any> {
  const { AuditChain } = await import("../audit_chain.js");
  const chain = new AuditChain();
  chain.appendEntry(
    "evidence",
    JSON.stringify({ filePath, action: "override", openFlags: _openFlags }),
  );
  return { overridden: true };
}

// ── Workspace / workflow ─────────────────────────────────────────────
export async function rerunWorkflow(): Promise<{ ok: boolean; error?: string; hint?: string }> {
  // Workflow runs are owned by HarnessDaemon (/api/run/start). Do not pretend
  // this chat-plane endpoint re-ran anything.
  return {
    ok: false,
    error: "noop",
    hint: "Use POST /api/run/start with a workflowId — /api/workflow/rerun does not execute workflows",
  };
}

/** Read a JSON body from an incoming request. */
export async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (d) => (buf += d.toString()));
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export { Readable };

// ─── The /api/* router (mounted by the launcher as the daemon apiHandler) ──

export async function browserApiHandler(req: {
  method: string;
  pathname: string;
  body: unknown;
}): Promise<unknown> {
  const { method, pathname, body } = req;
  const b = body as any;
  // Agent
  if (pathname === "/api/config/isConfigured" && method === "GET")
    return { configured: await isConfigured() };
  if (pathname === "/api/config" && method === "GET") return loadConfig();
  if (pathname === "/api/config/save" && method === "POST") return saveConfig(b.config);
  if (pathname === "/api/config/setCredential" && method === "POST")
    return setCredentialForUi(String(b.key ?? ""), String(b.value ?? ""));
  if (pathname === "/api/agent/start" && method === "POST") {
    await startAgent(b.config, b.resumeLatest);
    return { started: true };
  }
  if (pathname === "/api/agent/send" && method === "POST") {
    await sendToAgent(b.text);
    return { sent: true };
  }
  if (pathname === "/api/agent/approve" && method === "POST")
    return approveToolCall(b.approve, b.note);
  if (pathname === "/api/agent/consent" && method === "POST") {
    await consentRespond(b.decision);
    return { ok: true };
  }
  if (pathname === "/api/agent/respond" && method === "POST")
    return { ok: resolvePrompt(b.id, b.answer) };
  if (pathname === "/api/agent/stop" && method === "POST") {
    await stopAgent();
    return { ok: true };
  }
  // Sessions
  if (pathname === "/api/sessions" && method === "GET") return listSessions();
  if (pathname === "/api/sessions/load" && method === "POST") return loadSession(b.filePath);
  if (pathname === "/api/sessions/delete" && method === "POST") {
    await deleteSession(b.filePath);
    return { ok: true };
  }
  // Memory files
  if (pathname === "/api/memory" && method === "GET") return listMemory();
  if (pathname === "/api/memory/save" && method === "POST") {
    await saveMemory(b.name, b.content);
    return { ok: true };
  }
  if (pathname === "/api/memory/delete" && method === "POST") {
    await deleteMemory(b.name);
    return { ok: true };
  }
  if (pathname === "/api/memory/core" && method === "GET") return loadCoreMemory();
  if (pathname === "/api/memory/core/save" && method === "POST") {
    await saveCoreMemory(b.core);
    return { ok: true };
  }
  // Memory review
  if (pathname === "/api/memory/review" && method === "GET") return memoryReviewList();
  if (pathname === "/api/memory/review/action" && method === "POST") {
    await memoryReviewAction(b.factId, b.action, b.content);
    return { ok: true };
  }
  // Exclude/veto
  if (pathname === "/api/memory/exclude" && method === "POST") return excludeFromRun(b.memoryName);
  // Skills
  if (pathname === "/api/skills" && method === "GET") return listSkills();
  if (pathname === "/api/skills/read" && method === "POST")
    return { content: await readSkill(b.skillName) };
  if (pathname === "/api/skills/save" && method === "POST") {
    await saveSkill(b.skillName, b.content);
    return { ok: true };
  }
  // Preview / deliverables
  if (pathname === "/api/files/attach" && method === "POST") return stageAttachment(b);
  if (pathname === "/api/preview" && method === "POST") return previewFile(b.filePath);
  if (pathname === "/api/file/open" && method === "POST") {
    await openFile(b.filePath);
    return { ok: true };
  }
  if (pathname === "/api/file/showInFolder" && method === "POST") {
    await showInFolder(b.filePath);
    return { ok: true };
  }
  // Evidence
  if (pathname === "/api/evidence/load" && method === "POST") return loadEvidence(b.docFilePath);
  // Review flow
  if (pathname === "/api/review/markFinal" && method === "POST")
    return reviewMarkFinal(b.filePath, b.openFlags, b.figureStatuses);
  if (pathname === "/api/review/override" && method === "POST")
    return reviewOverride(b.filePath, b.openFlags, b.figureStatuses);
  // Workflow
  if (pathname === "/api/workflow/rerun" && method === "POST") return rerunWorkflow();
  // Runtime honesty surface — what the bound production runtime can/cannot do.
  if (pathname === "/api/runtime/status" && method === "GET") {
    const { getBoundProductionRuntime } = await import("./runtime-binding.js");
    const rt = getBoundProductionRuntime();
    if (!rt) return { bound: false, plane: "assistant-unbound" };
    return {
      bound: true,
      plane: "shared-production-runtime",
      deploymentProfile: rt.deploymentProfile,
      unavailable: rt.unavailable,
      research: !!rt.research,
      office: !!rt.office,
      brokerIntegrations: rt.broker.list().map((d) => d.name),
    };
  }
  // Unknown routes are a 404, never a 200-with-error-body: the UI must be
  // able to distinguish "saved" from "this endpoint does not exist" by status.
  return { __status: 404, error: `unknown route: ${method} ${pathname}` };
}

/** The SSE handler (mounted by the launcher as sseHandler). */
export function browserSseHandler(_req: IncomingMessage, res: ServerResponse): void {
  subscribe(res);
}
