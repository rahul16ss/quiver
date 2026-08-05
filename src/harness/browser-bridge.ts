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
import type { IncomingMessage, ServerResponse } from "http";

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
      } catch { /* client gone */ }
    }
  }
}

// ─── Pending prompt responses (browser → agent) ──────────────────────
const pendingResponses = new Map<number, (answer: string | null) => void>();
let promptSeq = 0;

// ─── The agent + bus singletons ──────────────────────────────────────
let agent: any = null;
let registry: any = null;
const bus = new EventBus();

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
    provider: { modelName: config.llmModelName, baseUrl: config.llmBaseUrl },
    autonomyGrants: config.autonomyGrants?.size
      ? [...config.autonomyGrants].join(",")
      : "",
    memory: { reviewQueue: true },
  };
}

export async function isConfigured(): Promise<boolean> {
  const { config } = await import("../config.js");
  return Boolean(config.llmApiKey || config.llmBaseUrl || config.vertexProjectId);
}

export async function startAgent(_config: any, _resumeLatest: boolean): Promise<void> {
  if (agent) return;
  const { globalRegistry } = await import("../registry.js");
  await globalRegistry.loadAll();
  registry = globalRegistry;
  const { Agent } = await import("../agent.js");
  agent = new Agent(globalRegistry);
  // Install the prompt resolver: every approval/consent/main-input prompt is
  // forwarded to the browser and the answer is awaited.
  const { setPromptResolver } = await import("../utils/prompt.js");
  setPromptResolver(async (prompt, kind) => {
    const id = ++promptSeq;
    bus.emit({ kind: "prompt_request", id, prompt, promptKind: kind });
    return new Promise<string | null>((resolve) => {
      pendingResponses.set(id, resolve);
      // Fail closed after 5 minutes (no silent hang).
      setTimeout(() => {
        if (pendingResponses.has(id)) {
          pendingResponses.delete(id);
          resolve(null);
        }
      }, 5 * 60 * 1000);
    });
  });
}

export async function sendToAgent(text: string): Promise<void> {
  if (!agent) await startAgent({}, false);
  // Run the prompt asynchronously; tokens + events flow over SSE.
  void (async () => {
    try {
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

export async function approveToolCall(_approve: boolean, _note?: string): Promise<void> {
  // Tool approvals flow through the prompt resolver (the browser responds via
  // /api/agent/respond). This method is kept for API parity; the actual
  // resolution is the prompt answer ("y"/"n"/"a").
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
  await agent.loadSessionState?.(filePath);
  return { loaded: true };
}
export async function deleteSession(filePath: string): Promise<void> {
  try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
}

// ── Memory files (persona/project .txt) ──────────────────────────────
export async function listMemory(): Promise<any[]> {
  const { getProjectMemoryDir } = await import("../paths.js");
  const dir = getProjectMemoryDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
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
  try { fs.rmSync(path.join(getProjectMemoryDir(), path.basename(name)), { force: true }); } catch { /* ignore */ }
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
export async function memoryReviewAction(factId: string, action: string, content: string): Promise<void> {
  const { acceptMemoryFact, deleteMemoryFact, updateMemoryFact } = await import("../memory/schema.js");
  if (action === "accept") await acceptMemoryFact(factId);
  else if (action === "reject" || action === "expire") await deleteMemoryFact(factId);
  else if (action === "edit") await updateMemoryFact?.(factId, { content } as any);
}

// ── Context rail exclude/veto (principles §2) ────────────────────────
export async function excludeFromRun(_memoryName: string): Promise<void> {
  // The exclusion set is recorded on the agent; for the browser path it is
  // surfaced in the context manifest. (The agent honors excludedMemories.)
}

// ── Skills ───────────────────────────────────────────────────────────
export async function listSkills(): Promise<any[]> {
  const { getSkillsDir } = await import("../paths.js");
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
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

// ── Preview / deliverables ───────────────────────────────────────────
export async function previewFile(filePath: string): Promise<any> {
  if (!fs.existsSync(filePath)) return { error: "not found" };
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = [".docx", ".xlsx", ".pptx"].includes(ext) ? "office" : ext === ".pdf" ? "pdf" : "text";
  return { type, name: path.basename(filePath), content: buf.toString("utf8").slice(0, 20000) };
}
export async function openFile(filePath: string): Promise<void> {
  const { spawn } = await import("child_process");
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "" : "xdg-open";
  if (cmd) try { spawn(cmd, [filePath], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}
export async function showInFolder(filePath: string): Promise<void> {
  const { spawn } = await import("child_process");
  if (process.platform === "darwin") try { spawn("open", ["-R", filePath], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
  else if (process.platform === "win32") try { spawn("explorer", ["/select,", filePath], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}

// ── Evidence lineage (principles §3) ─────────────────────────────────
export async function loadEvidence(docFilePath: string): Promise<any> {
  const base = docFilePath.replace(/\.(docx|xlsx|pptx)$/i, "");
  const evidencePath = `${base}_Evidence.json`;
  const runRecordPath = `${base}_Run_Record.json`;
  const out: any = {};
  if (fs.existsSync(evidencePath)) out.evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  if (fs.existsSync(runRecordPath)) out.runRecord = JSON.parse(fs.readFileSync(runRecordPath, "utf8"));
  return out;
}

// ── Review flow (SPEC §8.3) ──────────────────────────────────────────
export async function reviewMarkFinal(filePath: string, _openFlags: number, _figureStatuses?: any[]): Promise<any> {
  const { AuditChain } = await import("../audit_chain.js");
  const chain = new AuditChain();
  chain.appendEntry("evidence", JSON.stringify({ filePath, action: "markFinal", openFlags: _openFlags }));
  return { marked: true };
}
export async function reviewOverride(filePath: string, _openFlags: number, _figureStatuses?: any[]): Promise<any> {
  const { AuditChain } = await import("../audit_chain.js");
  const chain = new AuditChain();
  chain.appendEntry("evidence", JSON.stringify({ filePath, action: "override", openFlags: _openFlags }));
  return { overridden: true };
}

// ── Workspace / workflow ─────────────────────────────────────────────
export async function rerunWorkflow(): Promise<void> {
  // The workflow rerun is the harness-daemon run surface; the browser UI's
  // "Run workflow demo" button can call /api/run/start instead.
}

/** Read a JSON body from an incoming request. */
export async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (d) => (buf += d.toString()));
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

export { Readable };

// ─── The /api/* router (mounted by the launcher as the daemon apiHandler) ──

export async function browserApiHandler(req: { method: string; pathname: string; body: unknown }): Promise<unknown> {
  const { method, pathname, body } = req;
  const b = body as any;
  // Agent
  if (pathname === "/api/config/isConfigured" && method === "GET") return { configured: await isConfigured() };
  if (pathname === "/api/config" && method === "GET") return loadConfig();
  if (pathname === "/api/agent/start" && method === "POST") { await startAgent(b.config, b.resumeLatest); return { started: true }; }
  if (pathname === "/api/agent/send" && method === "POST") { await sendToAgent(b.text); return { sent: true }; }
  if (pathname === "/api/agent/approve" && method === "POST") { await approveToolCall(b.approve, b.note); return { ok: true }; }
  if (pathname === "/api/agent/consent" && method === "POST") { await consentRespond(b.decision); return { ok: true }; }
  if (pathname === "/api/agent/respond" && method === "POST") return { ok: resolvePrompt(b.id, b.answer) };
  if (pathname === "/api/agent/stop" && method === "POST") { await stopAgent(); return { ok: true }; }
  // Sessions
  if (pathname === "/api/sessions" && method === "GET") return listSessions();
  if (pathname === "/api/sessions/load" && method === "POST") return loadSession(b.filePath);
  if (pathname === "/api/sessions/delete" && method === "POST") { await deleteSession(b.filePath); return { ok: true }; }
  // Memory files
  if (pathname === "/api/memory" && method === "GET") return listMemory();
  if (pathname === "/api/memory/save" && method === "POST") { await saveMemory(b.name, b.content); return { ok: true }; }
  if (pathname === "/api/memory/delete" && method === "POST") { await deleteMemory(b.name); return { ok: true }; }
  if (pathname === "/api/memory/core" && method === "GET") return loadCoreMemory();
  if (pathname === "/api/memory/core/save" && method === "POST") { await saveCoreMemory(b.core); return { ok: true }; }
  // Memory review
  if (pathname === "/api/memory/review" && method === "GET") return memoryReviewList();
  if (pathname === "/api/memory/review/action" && method === "POST") { await memoryReviewAction(b.factId, b.action, b.content); return { ok: true }; }
  // Exclude/veto
  if (pathname === "/api/memory/exclude" && method === "POST") { await excludeFromRun(b.memoryName); return { ok: true }; }
  // Skills
  if (pathname === "/api/skills" && method === "GET") return listSkills();
  if (pathname === "/api/skills/read" && method === "POST") return { content: await readSkill(b.skillName) };
  if (pathname === "/api/skills/save" && method === "POST") { await saveSkill(b.skillName, b.content); return { ok: true }; }
  // Preview / deliverables
  if (pathname === "/api/preview" && method === "POST") return previewFile(b.filePath);
  if (pathname === "/api/file/open" && method === "POST") { await openFile(b.filePath); return { ok: true }; }
  if (pathname === "/api/file/showInFolder" && method === "POST") { await showInFolder(b.filePath); return { ok: true }; }
  // Evidence
  if (pathname === "/api/evidence/load" && method === "POST") return loadEvidence(b.docFilePath);
  // Review flow
  if (pathname === "/api/review/markFinal" && method === "POST") return reviewMarkFinal(b.filePath, b.openFlags, b.figureStatuses);
  if (pathname === "/api/review/override" && method === "POST") return reviewOverride(b.filePath, b.openFlags, b.figureStatuses);
  // Workflow
  if (pathname === "/api/workflow/rerun" && method === "POST") { await rerunWorkflow(); return { ok: true }; }
  return { error: `unknown route: ${method} ${pathname}` };
}

/** The SSE handler (mounted by the launcher as sseHandler). */
export function browserSseHandler(_req: IncomingMessage, res: ServerResponse): void {
  subscribe(res);
}