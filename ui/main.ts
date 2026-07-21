import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import * as path from "path";
import * as os from "os";
import * as fsSync from "fs";
import { fileURLToPath } from "url";
import { spawn, ChildProcess } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import { config } from "../src/config.ts";
import { resolveAndAssertPathAllowed, createDefaultPolicy } from "../src/security/path_policy.ts";
import { AuditChain } from "../src/audit_chain.ts";
import * as crypto from "crypto";
import {
  connectOrLaunch,
  daemonStatus,
  startAgentViaDaemon,
  sendLine,
  stopAgent as stopAgentViaDaemon,
  subscribe,
  type DaemonConnection,
  type AgentEventEntry,
} from "../src/daemon/client.ts";

// Set application name early so it registers properly with OS Dock and menus
app.setName("Quiver");

const execAsync = promisify(exec);

// ESM doesn't have __dirname — create it from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Strict Content-Security-Policy enforced on the renderer (US-8.1).
// Mirrors ui/security.ts CSP_POLICY; inlined here so the main process has no
// unresolved relative import (the renderer CSP contract lives in security.ts).
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// ─── Types ───────────────────────────────────────────────────────────

interface ProviderConfig {
  baseUrl: string;
  modelName: string;
  apiKey: string;
}

interface QuiverConfig {
  workspacePath: string;
  provider: ProviderConfig;
  parallelApiKey: string;
  ollamaApiKey: string;
  githubToken: string;
  /** Comma-separated autonomy grants (e.g. "write_file,run_command" or "yolo"). */
  autonomyGrants: string;
  maxContextTokens: number;
  memoryDir: string;
  skillsDir: string;
  cloudSyncPath: string;
  visionModelName?: string;
  visionModelBaseUrl?: string;
  sessionLogEnabled?: boolean;
  sessionLogMaxChars?: number;
  /** SPEC §6 consent gate — when true the agent blocks on pre-action approval. */
  consentGateEnabled?: boolean;
}

// ─── Globals ─────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let agentProcess: ChildProcess | null = null;

// S2 / SPEC §6: Memory exclusion set — files the user has vetoed from the
// context rail. Passed to the agent via QUIVER_EXCLUDED_MEMORIES env var so
// the agent's memory loader skips them when building context.
let excludedMemories: Set<string> = new Set();

// ─── Config Persistence ───────────────────────────────────────────────

const CONFIG_FILE = path.join(app.getPath("userData"), "quiver-config.json");

// ─── Quiver install root (self-modification guard, Epic 2 §2.5) ───────
// Resolve the directory that contains Quiver's own package.json (the app's
// installation/source tree). The agent child process receives this as
// QUIVER_PROTECTED_DIR and the path policy hard-blocks writes into it, so a
// GUI session can never rewrite Quiver's own source — regardless of what the
// configured workspace is. CLI/dev runs without the env var are unaffected.
function getQuiverInstallDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  // Dev mode: walk up from ui/ to the directory holding Quiver's package.json.
  let dir = path.resolve(__dirname, "..");
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(
        fsSync.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      if (typeof pkg.name === "string" && pkg.name.includes("quiver")) {
        return dir;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, "..");
}

// The default workspace for NEW configs is a documents folder in the user's
// home — never the app/source directory (Epic 2 §2.5). Created on first
// agent start by ensureWorkingDir. Existing saved configs are not rewritten.
const DEFAULT_WORKSPACE = path.join(os.homedir(), "Quiver Workspace");

function isWorkspaceAppSource(workspacePath: string): boolean {
  if (!workspacePath) return false;
  try {
    const installDir = fsSync.realpathSync(getQuiverInstallDir());
    let ws = path.resolve(workspacePath);
    try {
      ws = fsSync.realpathSync(ws);
    } catch {}
    const rel = path.relative(installDir, ws);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

const DEFAULT_CONFIG: QuiverConfig = {
  workspacePath: DEFAULT_WORKSPACE,
  provider: {
    baseUrl: config.llmBaseUrl,
    modelName: config.llmModelName,
    apiKey: "",
  },
  parallelApiKey: "",
  ollamaApiKey: "",
  githubToken: "",
  // Empty = conservative (ask for everything). "yolo" = bypass ALL gates.
  autonomyGrants: "",
  maxContextTokens: config.maxContextTokens,
  memoryDir: "./memory",
  skillsDir: "./skills",
  cloudSyncPath: "",
  consentGateEnabled: false,
};

async function loadConfig(): Promise<QuiverConfig> {
  try {
    const fs = await import("fs/promises");
    const content = await fs.readFile(CONFIG_FILE, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config: QuiverConfig): Promise<void> {
  try {
    // Strip computed, non-persistent fields (added by the config:load handler)
    // so they never end up in quiver-config.json.
    delete (config as any).workspaceIsAppSource;
    const fs = await import("fs/promises");
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save config:", err);
  }
}

async function isConfigured(): Promise<boolean> {
  const config = await loadConfig();
  return !!config.provider.apiKey;
}

// ─── Working Directory ────────────────────────────────────────────────
// In dev mode: use the project root (process.cwd())
// In packaged mode: use ~/.quiver/ as the working directory with .env,
// memory/, .sessions/, and skills/ subdirectories.

function getWorkingDir(config: QuiverConfig): string {
  if (config.workspacePath) return config.workspacePath;
  if (!app.isPackaged) {
    // Dev mode: use the project root (parent of ui/)
    return path.resolve(__dirname, "..");
  }

  // Packaged mode — use ~/.quiver/
  return path.join(app.getPath("home"), ".quiver");
}

async function ensureWorkingDir(dir: string): Promise<void> {
  try {
    const fs = await import("fs/promises");
    // Ensure the workspace directory exists
    await fs.mkdir(dir, { recursive: true });
    // Ensure the global ~/.quiver/ directory structure exists
    const quiverRoot = path.join(app.getPath("home"), ".quiver");
    await fs.mkdir(quiverRoot, { recursive: true });
    await fs.mkdir(path.join(quiverRoot, "skills"), { recursive: true });
    const projectName = path.basename(dir) || "default";
    await fs.mkdir(path.join(quiverRoot, "projects", projectName, "memory"), { recursive: true });
    await fs.mkdir(path.join(quiverRoot, "projects", projectName, ".sessions"), { recursive: true });
  } catch {
    // Non-critical
  }
}

// ─── .env Sync ───────────────────────────────────────────────────────
// Writes config values back to the working directory's .env so the CLI
// and GUI stay in sync.

async function syncToEnv(config: QuiverConfig): Promise<void> {
  try {
    const fs = await import("fs/promises");
    const workingDir = getWorkingDir(config);
    await ensureWorkingDir(workingDir);
    const envPath = path.resolve(workingDir, ".env");
    let envContent = "";

    try {
      envContent = await fs.readFile(envPath, "utf8");
    } catch {
      // No .env yet — start from example
      try {
        envContent = await fs.readFile(
          path.resolve(config.workspacePath || process.cwd(), ".env.example"),
          "utf8",
        );
      } catch {
        envContent = "";
      }
    }

    const replacements: Record<string, string> = {
      LLM_API_BASE_URL: config.provider.baseUrl,
      LLM_MODEL_NAME: config.provider.modelName,
      OLLAMA_API_KEY: config.ollamaApiKey || config.provider.apiKey,
      PARALLEL_API_KEY: config.parallelApiKey,
      GITHUB_TOKEN: config.githubToken,
      QUIVER_AUTONOMY: config.autonomyGrants || "",
      QUIVER_MAX_CONTEXT_TOKENS: String(config.maxContextTokens),
    };

    for (const [key, value] of Object.entries(replacements)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    await fs.writeFile(envPath, envContent.trim() + "\n", "utf8");
  } catch (err) {
    console.error("Failed to sync .env:", err);
  }
}

// ─── Agent Process Management ─────────────────────────────────────────

function getAgentCommand(): { cmd: string; args: string[] } {
  if (app.isPackaged) {
    // In packaged mode: use system `node` with tsx loader to run the
    // bundled CLI from the app's Resources directory.
    // The Cask's depends_on: node ensures `node` is on PATH.
    return {
      cmd: "node",
      args: [
        "--import",
        "tsx",
        path.join(process.resourcesPath, "src", "cli.ts"),
        "--json",
      ],
    };
  }

  // Dev mode: use local tsx binary with absolute path to cli.ts
  const projectRoot = path.resolve(__dirname, "..");
  const cliPath = path.join(projectRoot, "src", "cli.ts");
  const tsxBin = path.join(projectRoot, "node_modules", ".bin", "tsx");
  return {
    cmd: tsxBin,
    args: [cliPath, "--json"],
  };
}

// ─── Daemon connection (Epic 1 stage 1) ───────────────────────────────
// The daemon owns the agent child process so the session survives window
// and app restarts. The GUI connects (or launches the daemon), then either
// attaches to the running agent (same config) or starts a fresh one.
let daemonConn: DaemonConnection | null = null;
let daemonUnsub: (() => void) | null = null;
let lastEventSeq = 0;
let agentViaDaemon = false;
// Ring entries at or below this seq are replay (window was closed when they
// happened); "user" echoes above it are live and already rendered locally.
let replayCutoffSeq = 0;

function getDaemonCommand(): { cmd: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    return {
      cmd: "node",
      args: ["--import", "tsx", path.join(process.resourcesPath, "src", "daemon", "daemon.ts")],
      cwd: process.resourcesPath,
    };
  }
  const projectRoot = path.resolve(__dirname, "..");
  return {
    cmd: path.join(projectRoot, "node_modules", ".bin", "tsx"),
    args: [path.join(projectRoot, "src", "daemon", "daemon.ts")],
    cwd: projectRoot,
  };
}

/** Hash of everything that would change the agent's behavior; a running
 * agent with a different hash is restarted rather than attached to. */
function configLabel(env: Record<string, string | undefined>, cwd: string, args: string[]): string {
  const material = JSON.stringify({
    cwd,
    args,
    env: {
      LLM_API_BASE_URL: env.LLM_API_BASE_URL,
      LLM_MODEL_NAME: env.LLM_MODEL_NAME,
      QUIVER_AUTONOMY: env.QUIVER_AUTONOMY,
      QUIVER_MAX_CONTEXT_TOKENS: env.QUIVER_MAX_CONTEXT_TOKENS,
      QUIVER_CLOUD_SYNC_PATH: env.QUIVER_CLOUD_SYNC_PATH,
      QUIVER_PROTECTED_DIR: env.QUIVER_PROTECTED_DIR,
    },
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function forwardDaemonEntry(entry: AgentEventEntry): void {
  lastEventSeq = entry.seq;
  switch (entry.kind) {
    case "event": {
      try {
        mainWindow?.webContents.send("agent:event", JSON.parse(entry.payload));
      } catch {
        mainWindow?.webContents.send("agent:raw", entry.payload);
      }
      break;
    }
    case "raw":
      mainWindow?.webContents.send("agent:raw", entry.payload);
      break;
    case "stderr":
      mainWindow?.webContents.send("agent:stderr", entry.payload);
      break;
    case "exit": {
      let code: number | null = null;
      try {
        code = JSON.parse(entry.payload)?.code ?? null;
      } catch {
        // keep null
      }
      mainWindow?.webContents.send("agent:exit", { code });
      break;
    }
    case "error":
      mainWindow?.webContents.send("agent:error", { message: entry.payload });
      break;
    case "user":
      // Replay the user's side of the conversation after a window restart;
      // live echoes are skipped (the renderer already painted the bubble).
      if (entry.seq <= replayCutoffSeq) {
        mainWindow?.webContents.send("agent:event", {
          type: "user_replay",
          content: entry.payload,
        });
      }
      break;
    case "stopped":
      break; // expected transitions (restart/stop) — not a crash
  }
}

function subscribeToDaemon(fromSeq: number): void {
  if (!daemonConn) return;
  daemonUnsub?.();
  daemonUnsub = subscribe(daemonConn, fromSeq, forwardDaemonEntry, () => {
    // Daemon went away mid-session: tell the renderer and fall back cleanly.
    daemonUnsub = null;
    if (agentViaDaemon) {
      agentViaDaemon = false;
      daemonConn = null;
      mainWindow?.webContents.send("agent:exit", { code: null });
    }
  });
}

async function startAgent(config: QuiverConfig, resumeLatest: boolean = false): Promise<void> {
  if (agentProcess) {
    // Mark the old agent as expected-to-exit so its exit event isn't forwarded
    // to the renderer as a crash (which would mark the freshly-spawned agent
    // "stopped" and null out the global reference from under it).
    (agentProcess as any)._expectedExit = true;
    agentProcess.kill();
    agentProcess = null;
  }

  const { cmd, args } = getAgentCommand();
  const finalArgs = [...args];
  if (resumeLatest) {
    finalArgs.push("--continue");
  }

  const env = {
    ...process.env,
    LLM_API_BASE_URL: config.provider.baseUrl,
    LLM_MODEL_NAME: config.provider.modelName,
    OLLAMA_API_KEY: config.ollamaApiKey || config.provider.apiKey,
    PARALLEL_API_KEY: config.parallelApiKey,
    GITHUB_TOKEN: config.githubToken,
    QUIVER_AUTONOMY: config.autonomyGrants || "",
    QUIVER_MAX_CONTEXT_TOKENS: String(config.maxContextTokens),
    QUIVER_CLOUD_SYNC_PATH: config.cloudSyncPath || "",
    QUIVER_OUTPUT_MODE: "json", // GUI uses JSON mode for structured IPC
    QUIVER_EXCLUDED_MEMORIES: [...excludedMemories].join(","),
    // Consent gate (SPEC §6): when enabled in settings, the agent blocks on a
    // pre-action approval before each model call.
    QUIVER_CONSENT_GATE: config.consentGateEnabled ? "1" : "0",
    // Self-modification guard (Epic 2 §2.5): the agent's path policy refuses
    // any write into Quiver's own installation/source tree when this is set.
    QUIVER_PROTECTED_DIR: getQuiverInstallDir(),
  };

  // In packaged mode, set APP_ROOT to resourcesPath
  if (app.isPackaged) {
    (env as Record<string, string>).APP_ROOT = process.resourcesPath;
  }

  // Ensure working directory exists (creates ~/.quiver/ in packaged mode)
  const workingDir = getWorkingDir(config);
  await ensureWorkingDir(workingDir);

  // Write .env to the working directory so the CLI can read it
  await syncToEnv(config);

  // Daemon-first (Epic 1 stage 1): attach to the running agent when its
  // config matches; otherwise (re)start it through the daemon. The env goes
  // to the daemon over loopback with bearer-token auth — the same trust
  // boundary as the 0600 token file. If the daemon can't be reached, fall
  // back to the legacy directly-owned child process below.
  const label = configLabel(env, workingDir, finalArgs);
  try {
    daemonConn = await connectOrLaunch(getDaemonCommand());
    const status = await daemonStatus(daemonConn);
    lastEventSeq = 0;
    replayCutoffSeq = status.lastSeq;
    // Subscribe from 0 in both paths: on attach the ring replay rebuilds the
    // conversation where the user left it; on a fresh start it is empty.
    subscribeToDaemon(0);
    if (!(status.running && status.label === label && !resumeLatest)) {
      await startAgentViaDaemon(daemonConn, {
        cmd,
        args: finalArgs,
        cwd: workingDir,
        env,
        label,
      });
    }
    agentViaDaemon = true;
    return;
  } catch (err) {
    console.error("Daemon unavailable, falling back to direct agent spawn:", err);
    daemonUnsub?.();
    daemonUnsub = null;
    daemonConn = null;
    agentViaDaemon = false;
  }

  const proc = spawn(cmd, finalArgs, {
    cwd: workingDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        mainWindow?.webContents.send("agent:event", msg);
      } catch {
        // Non-JSON output - forwarded as raw
        mainWindow?.webContents.send("agent:raw", line);
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    mainWindow?.webContents.send("agent:stderr", data.toString());
  });

  proc.on("exit", (code) => {
    // A deliberately-killed agent (restart) is expected: don't tell the
    // renderer it "stopped", and only clear the global if it still refers to
    // this process (a newer spawn may already have replaced it).
    if ((proc as any)._expectedExit) {
      if (agentProcess === proc) agentProcess = null;
      return;
    }
    mainWindow?.webContents.send("agent:exit", { code });
    if (agentProcess === proc) agentProcess = null;
  });

  agentProcess = proc;
}

function sendToAgent(text: string): void {
  if (agentViaDaemon && daemonConn) {
    void sendLine(daemonConn, text, "user").then((ok) => {
      if (!ok) {
        mainWindow?.webContents.send("agent:error", { message: "Agent is not running" });
      }
    });
    return;
  }
  if (!agentProcess || !agentProcess.stdin) {
    mainWindow?.webContents.send("agent:error", {
      message: "Agent is not running",
    });
    return;
  }
  agentProcess.stdin.write(text + "\n");
}

function approveToolCall(approve: boolean, note?: string): void {
  // "y" approves once; "a" approves all-similar-this-session; "n" denies.
  // An optional revision note is sent as a second line on deny so the agent
  // can feed concrete revision guidance back to the model (US-2.4).
  const choice = approve ? (note === "all" ? "a" : "y") : "n";
  if (agentViaDaemon && daemonConn) {
    void sendLine(daemonConn, choice).then(() => {
      if (!approve && daemonConn) void sendLine(daemonConn, note ? note : "");
    });
    return;
  }
  if (!agentProcess || !agentProcess.stdin) return;
  agentProcess.stdin.write(choice + "\n");
  if (!approve) {
    agentProcess.stdin.write((note ? note : "") + "\n");
  }
}

// ─── Review flow audit (SPEC §8.3 — override is logged) ───────────────
// The reviewer's mark-final / override decisions are appended to a
// tamper-evident audit chain on disk (alongside the deliverable) and a
// per-document review record is written. This is the review record that
// goes with the memo: it records the reviewer's checks, whether the
// document was marked final, and any override.
function reviewAuditPath(filePath: string): string {
  const dir = path.dirname(filePath || "");
  const base = (path.basename(filePath || "document") || "document").replace(/\.(docx|xlsx|pptx)$/, "");
  return path.join(dir, `${base}_Review_Audit.json`);
}
function reviewRecordPath(filePath: string): string {
  const dir = path.dirname(filePath || "");
  const base = (path.basename(filePath || "document") || "document").replace(/\.(docx|xlsx|pptx)$/, "");
  return path.join(dir, `${base}_Review_Record.json`);
}

async function logReviewDecision(
  filePath: string,
  openFlags: number,
  action: "marked_final" | "override",
  figureStatuses?: any,
): Promise<{ logged: boolean; blocked: boolean; action: string }> {
  const auditPath = reviewAuditPath(filePath);
  const recordPath = reviewRecordPath(filePath);
  try {
    let chain: AuditChain;
    try {
      const raw = await fsSync.promises.readFile(auditPath, "utf8");
      chain = AuditChain.deserialize(raw);
    } catch {
      chain = new AuditChain();
    }
    chain.appendEntry(
      "approval",
      JSON.stringify({
        review_decision: action,
        deliverable: filePath,
        open_flags: openFlags,
        timestamp: new Date().toISOString(),
      }),
    );
    await fsSync.promises.mkdir(path.dirname(auditPath), { recursive: true });
    await fsSync.promises.writeFile(auditPath, chain.serialize(), "utf8");
    // Write / update the per-document review record.
    let record: any = {};
    try {
      record = JSON.parse(await fsSync.promises.readFile(recordPath, "utf8"));
    } catch {
      record = {};
    }
    record.deliverable = filePath;
    record.open_flags = openFlags;
    record.final = action === "marked_final" ? true : Boolean(record.final) || openFlags === 0;
    if (action === "override") record.override_logged = true;
    record.last_action = action;
    record.updated_at = new Date().toISOString();
    // The reviewer's per-figure checks ARE the review record that goes with
    // the memo (SPEC §8.3).
    if (Array.isArray(figureStatuses)) record.figure_checks = figureStatuses;
    await fsSync.promises.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
    return { logged: true, blocked: false, action };
  } catch {
    return { logged: false, blocked: false, action };
  }
}

// ─── Memory File Management ──────────────────────────────────────────

function getProjectMemoryDir(workspacePath: string): string {
  let projectName: string;
  if (workspacePath) {
    projectName = path.basename(workspacePath);
  } else if (!app.isPackaged) {
    projectName = path.basename(path.resolve(__dirname, ".."));
  } else {
    projectName = path.basename(process.cwd()) || "default";
  }
  return path.join(app.getPath("home"), ".quiver", "projects", projectName, "memory");
}

async function listMemoryFiles(): Promise<
  { name: string; content: string; size: number }[]
> {
  try {
    const config = await loadConfig();
    const fs = await import("fs/promises");
    const memDir = getProjectMemoryDir(config.workspacePath || "");
    const files = await fs.readdir(memDir);
    const results: { name: string; content: string; size: number }[] = [];
    for (const file of files) {
      if (file.startsWith(".")) continue;
      if (file === "facts.jsonl" || file === "project.json") continue;
      const filePath = path.join(memDir, file);
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const content = await fs.readFile(filePath, "utf8");
        results.push({ name: file, content, size: stat.size });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function saveMemoryFile(name: string, content: string): Promise<boolean> {
  try {
    const config = await loadConfig();
    const fs = await import("fs/promises");
    const memDir = getProjectMemoryDir(config.workspacePath || process.cwd());
    const targetFile = path.join(memDir, name);
    // Path-policy guard (US-8.1): `name` comes from the renderer (untrusted
    // model output). Confine writes to the memory dir via the real path policy
    // so a traversal like "../../etc/cron.d/x" is rejected, not just "..".
    resolveAndAssertPathAllowed(targetFile, "write", createDefaultPolicy(memDir));
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(targetFile, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function deleteMemoryFile(name: string): Promise<boolean> {
  try {
    const config = await loadConfig();
    const fs = await import("fs/promises");
    const memDir = getProjectMemoryDir(config.workspacePath || process.cwd());
    const filePath = path.join(memDir, name);
    // Safety: only delete files within the memory directory
    if (!filePath.startsWith(memDir)) return false;
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Window Management ────────────────────────────────────────────────


async function fs2read(ws: typeof import("fs/promises"), p: string): Promise<string> {
  return ws.readFile(p, "utf8");
}

async function createWindow(): Promise<void> {
  const configured = await isConfigured();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Quiver",
    show: false,
    icon: path.join(__dirname, "renderer", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Persist window size/position across launches (US-8.1), with validation:
  // restored bounds are clamped to the visible screen and the minimum size so
  // a window never restores off-screen or impossibly small.
  const windowStateFile = path.join(app.getPath("userData"), "window-state.json");
  try {
    const ws = await import("fs/promises");
    const saved = JSON.parse(await fs2read(ws, windowStateFile));
    if (saved && typeof saved.width === "number" && typeof saved.height === "number") {
      const screen = (await import("electron")).screen;
      const displays = screen.getAllDisplays();
      const onScreen = displays.some((d) => {
        const a = d.workArea;
        return saved.x >= a.x - 200 && saved.y >= a.y - 200 &&
          saved.x + saved.width <= a.x + a.width + 200 &&
          saved.y + saved.height <= a.y + a.height + 200;
      });
      const width = Math.max(800, Math.min(saved.width, 2400));
      const height = Math.max(600, Math.min(saved.height, 1800));
      mainWindow.setBounds({ x: onScreen ? saved.x : undefined, y: onScreen ? saved.y : undefined, width, height });
    }
  } catch {
    // no saved state — use defaults
  }
  const persistBounds = () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    import("fs/promises").then((ws) => ws.writeFile(windowStateFile, JSON.stringify(b), "utf8")).catch(() => {});
  };
  mainWindow.on("resize", persistBounds);
  mainWindow.on("move", persistBounds);
  mainWindow.on("close", persistBounds);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Load onboarding if not configured, otherwise main app
  if (!configured) {
    mainWindow.loadFile(path.join(__dirname, "renderer", "onboarding.html"));
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
}

// ─── Sessions Management ──────────────────────────────────────────────

function getProjectSessionsDir(workspacePath: string): string {
  // In dev mode, workspacePath may be empty and process.cwd() is the Electron
  // binary dir. Fall back to the project root (parent of ui/).
  let projectName: string;
  if (workspacePath) {
    projectName = path.basename(workspacePath);
  } else if (!app.isPackaged) {
    // __dirname is ui/ — go up one level to get the project root
    projectName = path.basename(path.resolve(__dirname, ".."));
  } else {
    projectName = path.basename(process.cwd()) || "default";
  }
  return path.join(app.getPath("home"), ".quiver", "projects", projectName, ".sessions");
}

async function listSessions(): Promise<any[]> {
  try {
    const config = await loadConfig();
    const fs = await import("fs/promises");
    const sessionsDir = getProjectSessionsDir(config.workspacePath || "");
    const files = await fs.readdir(sessionsDir);
    const stateFiles = files.filter((f) => f.endsWith(".state.json"));
    const results: any[] = [];
    for (const f of stateFiles) {
      try {
        const filePath = path.join(sessionsDir, f);
        const content = await fs.readFile(filePath, "utf8");
        const state = JSON.parse(content);
        // Human title (Epic 2 §2.2): the first user message, truncated.
        // Falls back to empty — the renderer formats the date instead.
        let title = "";
        for (const msg of state.messages || []) {
          if (msg?.role !== "user") continue;
          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            text = msg.content
              .map((p: any) => (p?.type === "text" ? p.text || "" : ""))
              .join(" ");
          }
          // Skip attachment markers so "[Image: /path]" doesn't become a title
          text = text.replace(/\[Image:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
          if (text) {
            title = text.length > 60 ? text.slice(0, 57).trimEnd() + "…" : text;
            break;
          }
        }
        results.push({
          sessionId: state.sessionId || f.replace(".state.json", ""),
          title,
          path: filePath,
          savedAt: state.savedAt || new Date().toISOString(),
          messageCount: state.messages?.length || 0,
          model: state.model || DEFAULT_CONFIG.provider.modelName,
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

async function loadSessionFile(filePath: string): Promise<any> {
  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function deleteSessionFile(filePath: string, permanent: boolean = false): Promise<boolean> {
  if (permanent) {
    return permanentlyDeleteSessionFile(filePath);
  }
  try {
    const fs = await import("fs/promises");
    // US-8.2: Session deletion moves files to an archive/trash folder
    // instead of silent hard-deletion, unless the user selects "Permanent Delete".
    const sessionsDir = path.dirname(filePath);
    const archiveDir = path.join(sessionsDir, "archive");
    await fs.mkdir(archiveDir, { recursive: true });

    // Move state file to archive
    const basename = path.basename(filePath);
    const archivePath = path.join(archiveDir, basename);
    await fs.rename(filePath, archivePath);

    // Also move corresponding log files if they exist
    const logPath = filePath.replace(".state.json", ".json");
    try { await fs.rename(logPath, path.join(archiveDir, path.basename(logPath))); } catch {}
    const loglPath = filePath.replace(".state.json", ".jsonl");
    try { await fs.rename(loglPath, path.join(archiveDir, path.basename(loglPath))); } catch {}

    return true;
  } catch {
    return false;
  }
}

async function permanentlyDeleteSessionFile(filePath: string): Promise<boolean> {
  try {
    const fs = await import("fs/promises");
    await fs.unlink(filePath);
    const logPath = filePath.replace(".state.json", ".json");
    try { await fs.unlink(logPath); } catch {}
    const loglPath = filePath.replace(".state.json", ".jsonl");
    try { await fs.unlink(loglPath); } catch {}
    return true;
  } catch {
    return false;
  }
}

async function touchSessionFile(filePath: string): Promise<boolean> {
  try {
    const fs = await import("fs/promises");
    const now = new Date();
    await fs.utimes(filePath, now, now);
    return true;
  } catch {
    return false;
  }
}

// ─── OfficeCLI Binary Discovery ──────────────────────────────────────

/**
 * Find the OfficeCLI binary on PATH.
 * Returns the path or null if not installed.
 */
async function findOfficeCliBinary(): Promise<string | null> {
  try {
    const { execFileSync } = await import("child_process");
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, ["officecli"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    });
    const found = result.trim().split("\n")[0].trim();
    return found || null;
  } catch {
    return null;
  }
}

// ─── Additional Context/Verification Helpers ─────────────────────────

async function runWorkspaceTests(): Promise<{ success: boolean; output: string }> {
  const config = await loadConfig();
  const workspaceDir = config.workspacePath || process.cwd();
  try {
    const { stdout, stderr } = await execAsync("npm test", { cwd: workspaceDir });
    return { success: true, output: stdout || stderr };
  } catch (err: any) {
    return { success: false, output: err.stdout || err.stderr || err.message };
  }
}

async function listSkills(workspacePath: string, skillsDirConfig: string): Promise<string[]> {
  try {
    const fs = await import("fs/promises");
    // Prefer global skills dir (~/.quiver/skills/), fall back to configured path
    const globalSkillsDir = path.join(app.getPath("home"), ".quiver", "skills");
    let skillsDir: string;
    try {
      await fs.access(globalSkillsDir);
      skillsDir = globalSkillsDir;
    } catch {
      skillsDir = path.isAbsolute(skillsDirConfig) ? skillsDirConfig : path.resolve(workspacePath, skillsDirConfig);
    }
    const files = await fs.readdir(skillsDir);
    const results: string[] = [];
    for (const f of files) {
      if (f.startsWith(".")) continue;
      const fullPath = path.join(skillsDir, f);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        results.push(f);
      } else if (f.endsWith(".md")) {
        results.push(f);
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // Config
  ipcMain.handle("config:load", async () => {
    const config = await loadConfig();
    // Computed flag (never persisted — see saveConfig): lets the renderer
    // show a one-time warning banner when the configured workspace IS the
    // app source tree (Epic 2 §2.5). The hard block applies regardless.
    return {
      ...config,
      workspaceIsAppSource: isWorkspaceAppSource(config.workspacePath || ""),
    };
  });
  ipcMain.handle("config:save", async (_evt, config: QuiverConfig) => {
    await saveConfig(config);
    await syncToEnv(config);
    return true;
  });
  ipcMain.handle("config:isConfigured", async () => isConfigured());

  // Agent
  ipcMain.handle("agent:start", async (_evt, config: QuiverConfig, resumeLatest: boolean = false) => {
    await startAgent(config, resumeLatest);
    return true;
  });
  ipcMain.handle("agent:send", async (_evt, text: string) => {
    sendToAgent(text);
    return true;
  });
  ipcMain.handle("agent:approve", async (_evt, payload: any) => {
    const approve = typeof payload === "boolean" ? payload : payload?.approve === true;
    const note = typeof payload === "object" && payload ? payload?.note : undefined;
    approveToolCall(approve, note);
    return true;
  });
  ipcMain.handle("agent:stop", async () => {
    // An explicit user Stop halts the agent everywhere — including in the
    // daemon. (Closing the window, by contrast, leaves it running.)
    if (agentViaDaemon && daemonConn) {
      await stopAgentViaDaemon(daemonConn).catch(() => {});
    }
    if (agentProcess) {
      agentProcess.kill();
      agentProcess = null;
    }
    return true;
  });

  // ── Path-policy guard for IPC handlers (US-8.1) ──
  // Prevents the renderer (driven by untrusted model output) from reading
  // sensitive paths (~/.ssh, ~/.aws, .env) or writing outside allowed roots.
  function ipcPathGuard(filePath: string, op: "read" | "write"): string | null {
    try {
      const workspace = process.cwd();
      const policy = createDefaultPolicy(workspace);
      resolveAndAssertPathAllowed(filePath, op, policy);
      return null; // allowed
    } catch (e: any) {
      return e.message;
    }
  }

  // Sessions live under ~/.quiver/projects/<project>/.sessions/ (or a legacy
  // <workspace>/.sessions/), which is OUTSIDE the workspace-rooted default
  // policy — the generic ipcPathGuard would reject every legitimate session
  // path (that bug rendered resumed sessions as a blank conversation). This
  // guard is instead scoped to exactly the session stores and .state.json
  // files, which is both correct and tighter than the generic guard.
  async function sessionPathGuard(filePath: string): Promise<string | null> {
    try {
      const resolved = fsSync.realpathSync(path.resolve(filePath));
      if (!resolved.endsWith(".state.json")) return "Not a session state file";
      const projectsRoot = fsSync.realpathSync(
        path.join(app.getPath("home"), ".quiver", "projects"),
      );
      const inProjects = resolved.startsWith(projectsRoot + path.sep);
      let inWorkspace = false;
      try {
        const ws = fsSync.realpathSync(getWorkingDir(await loadConfig()));
        inWorkspace = resolved.startsWith(path.join(ws, ".sessions") + path.sep);
      } catch {
        // no workspace configured — projects root check stands alone
      }
      if (!inProjects && !inWorkspace) return "Path is outside the session stores";
      return null;
    } catch (e: any) {
      return e?.message || "Invalid session path";
    }
  }

  // Second layer under the store-membership guard: the path-policy engine
  // (symlink realpath, traversal, blocked sensitive globs) runs on the live
  // path inside every handler body (US-8.1), rooted at the session file's own
  // directory since store membership is already proven by sessionPathGuard.
  const sessionPolicyFor = (filePath: string) =>
    createDefaultPolicy(path.dirname(path.resolve(filePath)));

  ipcMain.handle("sessions:list", async () => listSessions());
  ipcMain.handle("sessions:load", async (_evt, filePath: string) => {
    const guardErr = await sessionPathGuard(filePath);
    if (guardErr) return { error: guardErr };
    try {
      resolveAndAssertPathAllowed(filePath, "read", sessionPolicyFor(filePath));
    } catch (e: any) {
      return { error: e?.message || "Path policy rejected the session path" };
    }
    return loadSessionFile(filePath);
  });
  ipcMain.handle("sessions:delete", async (_evt, filePath: string, permanent: boolean = false) => {
    const guardErr = await sessionPathGuard(filePath);
    if (guardErr) return { error: guardErr };
    try {
      resolveAndAssertPathAllowed(filePath, "write", sessionPolicyFor(filePath));
    } catch (e: any) {
      return { error: e?.message || "Path policy rejected the session path" };
    }
    return deleteSessionFile(filePath, permanent);
  });
  ipcMain.handle("sessions:touch", async (_evt, filePath: string) => {
    const guardErr = await sessionPathGuard(filePath);
    if (guardErr) return { error: guardErr };
    try {
      resolveAndAssertPathAllowed(filePath, "write", sessionPolicyFor(filePath));
    } catch (e: any) {
      return { error: e?.message || "Path policy rejected the session path" };
    }
    return touchSessionFile(filePath);
  });

  // Memory
  ipcMain.handle("memory:list", async () => listMemoryFiles());
  ipcMain.handle("memory:save", async (_evt, name: string, content: string) =>
    saveMemoryFile(name, content),
  );
  ipcMain.handle("memory:delete", async (_evt, name: string) =>
    deleteMemoryFile(name),
  );
  ipcMain.handle("memory:loadCore", async () => {
    const config = await loadConfig();
    const memoryFile = path.join(app.getPath("home"), ".quiver", "core.json");
    try {
      const fs = await import("fs/promises");
      const content = await fs.readFile(memoryFile, "utf8");
      return JSON.parse(content);
    } catch {
      return {
        identity: "You are Quiver, an AI work assistant for business users — analysts, researchers, consultants, and legal professionals.",
        human_context: "",
        project_context: ""
      };
    }
  });
  ipcMain.handle("memory:saveCore", async (_evt, coreMemory: any) => {
    const config = await loadConfig();
    const memoryFile = path.join(app.getPath("home"), ".quiver", "core.json");
    try {
      const fs = await import("fs/promises");
      await fs.mkdir(path.dirname(memoryFile), { recursive: true });
      // Path-policy guard for the write
      const guardErr = ipcPathGuard(memoryFile, "write");
      if (guardErr) return false;
      await fs.writeFile(memoryFile, JSON.stringify(coreMemory, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
  });

  // US-8.4: Settings IPC handlers
  ipcMain.handle("settings:get", async () => {
    return await loadConfig();
  });
  ipcMain.handle("settings:update", async (_evt, payload: { section: string; values: any }) => {
    const config = await loadConfig();
    const { section, values } = payload;
    // Update the requested section
    if (section === "provider") {
      config.provider = { ...config.provider, ...values };
    } else if (section === "vision") {
      config.visionModelName = values.visionModelName || config.visionModelName;
      config.visionModelBaseUrl = values.visionModelBaseUrl || config.visionModelBaseUrl;
    } else if (section === "autonomy") {
      config.autonomyGrants = values.grants || "";
    } else if (section === "sync") {
      config.cloudSyncPath = values.syncPath || "";
    } else if (section === "memory") {
      config.sessionLogEnabled = values.sessionLogEnabled !== false;
      config.sessionLogMaxChars = values.sessionLogMaxChars || 512;
    } else if (section === "consent") {
      config.consentGateEnabled = values.consentGateEnabled === true;
    }
    await saveConfig(config);
    return true;
  });
  ipcMain.handle("settings:set-credential", async (_evt, payload: { key: string; value: string }) => {
    try {
      const { setCredential, isKeychainAvailable } = await import("../src/secrets/keychain.js");
      if (isKeychainAvailable() && await setCredential(payload.key, payload.value)) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  });

  // US-4.4: Sync IPC handlers
  ipcMain.handle("sync:status", async () => {
    try {
      const { getCloudSyncStatus } = await import("../src/cloud_sync.js");
      return await getCloudSyncStatus();
    } catch {
      return { active: false, path: "" };
    }
  });
  ipcMain.handle("sync:enable", async (_evt, payload: { path: string }) => {
    try {
      const config = await loadConfig();
      config.cloudSyncPath = payload.path;
      await saveConfig(config);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle("sync:disable", async () => {
    try {
      const config = await loadConfig();
      config.cloudSyncPath = "";
      await saveConfig(config);
      return true;
    } catch {
      return false;
    }
  });

  // US-12.2: Memory review IPC handlers
  ipcMain.handle("memory:review:list", async () => {
    try {
      const { getPendingFacts, getAllFactsForReview } = await import("../src/memory/review_queue.js");
      return await getAllFactsForReview();
    } catch {
      return [];
    }
  });
  ipcMain.handle("memory:review:action", async (_evt, payload: { factId: string; action: string; content: string }) => {
    try {
      const { processReview } = await import("../src/memory/review_queue.js");
      return await processReview(payload.factId, payload.action as any, payload.content || undefined);
    } catch (error: any) {
      return { action: payload.action, factId: payload.factId, success: false, message: error?.message || "Failed" };
    }
  });

  // S2 / SPEC §6: Memory exclude/veto — the user can exclude memory files
  // from the next agent run via the context rail. The exclusion set is
  // passed to the agent process via QUIVER_EXCLUDED_MEMORIES env var.
  ipcMain.handle("memory:exclude", async (_evt, payload: { memoryName: string }) => {
    if (payload?.memoryName) {
      if (excludedMemories.has(payload.memoryName)) {
        excludedMemories.delete(payload.memoryName);
      } else {
        excludedMemories.add(payload.memoryName);
      }
    }
    return { excluded: [...excludedMemories] };
  });

  // ── Consent gate (SPEC §6 — "a gate, not a post-hoc log") ───────────
  // The renderer sends the user's approve/decline/exclude decision; main
  // forwards it to the agent process so the gate can unblock (approve) or
  // abort the turn (decline/exclude). The decision is logged to the
  // tamper-evident audit chain by the agent.
  ipcMain.handle("consent:respond", async (_evt, payload: { decision: string }) => {
    const decision = String(payload?.decision || "").toLowerCase();
    // H3: forward an explicit token to the blocked agent. Default to DENY on
    // any unrecognized input so a malformed/empty decision cannot approve.
    const token = decision.startsWith("e")
      ? "exclude"
      : /^(a|y|yes|approve|allow)$/.test(decision)
        ? "approve"
        : "decline";
    if (agentViaDaemon && daemonConn) {
      void sendLine(daemonConn, token).then((ok) => {
        if (!ok) mainWindow?.webContents.send("agent:error", { message: "Agent is not running" });
      });
      return { sent: true };
    }
    if (!agentProcess || !agentProcess.stdin) return { sent: false };
    agentProcess.stdin.write(token + "\n");
    return { sent: true };
  });

  // ── Review flow (SPEC §8.3 — override is logged) ───────────────────
  // The reviewer's mark-final / override decisions are appended to a
  // tamper-evident audit chain on disk and a per-document review record is
  // written next to the deliverable. This is the review record that goes
  // with the memo.
  ipcMain.handle("review:markFinal", async (_evt, payload: any) => {
    return logReviewDecision(payload?.filePath, payload?.openFlags || 0, "marked_final", payload?.figureStatuses);
  });
  ipcMain.handle("review:override", async (_evt, payload: any) => {
    return logReviewDecision(payload?.filePath, payload?.openFlags || 0, "override", payload?.figureStatuses);
  });

  // Skills
  ipcMain.handle("skills:list", async () => {
    const config = await loadConfig();
    return listSkills(config.workspacePath || process.cwd(), config.skillsDir || "./skills");
  });
  ipcMain.handle("skills:read", async (_evt, skillName: string) => {
    const fs = await import("fs/promises");
    // Prefer global skills dir (~/.quiver/skills/)
    const globalSkillsDir = path.join(app.getPath("home"), ".quiver", "skills");
    const skillDir = path.join(globalSkillsDir, skillName);
    const skillFile = path.join(skillDir, "SKILL.md");
    try {
      return await fs.readFile(skillFile, "utf8");
    } catch {
      try {
        const standalone = path.resolve(globalSkillsDir, skillName);
        return await fs.readFile(standalone, "utf8");
      } catch {
        return null;
      }
    }
  });
  ipcMain.handle("skills:save", async (_evt, skillName: string, content: string) => {
    const fs = await import("fs/promises");
    // Save to global skills dir (~/.quiver/skills/)
    const globalSkillsDir = path.join(app.getPath("home"), ".quiver", "skills");
    const skillDir = path.join(globalSkillsDir, skillName);
    const skillFile = path.join(skillDir, "SKILL.md");
    // Path-policy guard (US-8.1): reject traversal/double-quote escapes via the
    // real path policy rooted at the skills dir — not a hand-rolled substring
    // check. The renderer is driven by untrusted model output.
    try {
      resolveAndAssertPathAllowed(skillFile, "write", createDefaultPolicy(globalSkillsDir));
    } catch {
      return false;
    }
    try {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillFile, content, "utf8");
      return true;
    } catch {
      return false;
    }
  });

  // Workspace / Verification
  ipcMain.handle("workspace:runTests", async () => runWorkspaceTests());
  ipcMain.handle("workspace:selectDir", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // ── Deliverable actions (Epic 2 §2.4) ──
  // Open a produced document in its native app / reveal it in Finder.
  // Validation: the renderer is driven by untrusted model output, so the
  // path must resolve inside the configured workspace (documents live there)
  // and must pass the path policy (no .env/keys/VCS internals).
  async function validateDeliverablePath(filePath: string): Promise<string | null> {
    try {
      if (typeof filePath !== "string" || !filePath.trim()) return "No file path given.";
      const config = await loadConfig();
      const workspace = path.resolve(config.workspacePath || process.cwd());
      let real = path.resolve(filePath);
      try {
        real = fsSync.realpathSync(real);
      } catch {
        return "This file doesn't exist.";
      }
      let wsReal = workspace;
      try {
        wsReal = fsSync.realpathSync(workspace);
      } catch {}
      const rel = path.relative(wsReal, real);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return "Only files inside your workspace folder can be opened from here.";
      }
      resolveAndAssertPathAllowed(real, "read", createDefaultPolicy(wsReal));
      return null;
    } catch (e: any) {
      return e?.message || "This file can't be opened.";
    }
  }
  ipcMain.handle("file:open", async (_evt, filePath: string) => {
    const err = await validateDeliverablePath(filePath);
    if (err) return { error: err };
    const result = await shell.openPath(path.resolve(filePath));
    return result ? { error: result } : { ok: true };
  });
  ipcMain.handle("file:showInFolder", async (_evt, filePath: string) => {
    const err = await validateDeliverablePath(filePath);
    if (err) return { error: err };
    shell.showItemInFolder(path.resolve(filePath));
    return { ok: true };
  });

  // Preview — read a file and return its content + type for the preview panel
  ipcMain.handle("preview:file", async (_evt, filePath: string) => {
    try {
      // Path-policy guard: reject sensitive paths
      const guardErr = ipcPathGuard(filePath, "read");
      if (guardErr) return { error: guardErr };
      const fs = await import("fs/promises");
      const ext = path.extname(filePath).toLowerCase();
      const stat = await fs.stat(filePath);
      if (stat.size > 10 * 1024 * 1024) {
        return { error: "File too large to preview (>10MB)", type: ext };
      }

      // For Office documents, use OfficeCLI to extract text content
      if (ext === ".docx" || ext === ".xlsx" || ext === ".pptx") {
        try {
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFile);
          const officecliBin = await findOfficeCliBinary();
          if (officecliBin) {
            const { stdout } = await execFileAsync(officecliBin, [
              "view", filePath, "--mode", "text",
            ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
            return { content: stdout, type: ext, officeDoc: true };
          }
        } catch {
          // OfficeCLI not available — fall through
        }
        return { error: "Office documents can't be previewed yet. The Office engine isn't installed; it installs automatically the first time Quiver creates a document.", type: ext };
      }

      // For text-based files, read as UTF-8
      const textExts = [".md", ".txt", ".json", ".js", ".ts", ".tsx", ".jsx",
        ".css", ".html", ".xml", ".yaml", ".yml", ".csv", ".tsv", ".py",
        ".rs", ".go", ".java", ".c", ".cpp", ".h", ".sh", ".sql", ".env",
        ".toml", ".ini", ".cfg", ".log", ".diff", ".patch"];
      if (textExts.includes(ext) || ext === "") {
        const content = await fs.readFile(filePath, "utf8");
        return { content, type: ext || ".txt" };
      }

      // For images, return a file:// URL the renderer can load
      const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico"];
      if (imageExts.includes(ext)) {
        return { imageUrl: `file://${filePath}`, type: ext, isImage: true };
      }

      // For PDFs, return a file:// URL for the embedded viewer
      if (ext === ".pdf") {
        return { pdfUrl: `file://${filePath}`, type: ext, isPdf: true };
      }

      return { error: `Cannot preview ${ext} files`, type: ext };
    } catch (err: any) {
      if (err?.code === "ENOENT") return { error: "This file hasn't been created yet." };
      return { error: err.message || "Couldn't preview this file." };
    }
  });

  // Navigation
  ipcMain.handle("nav:loadMain", async () => {
    mainWindow?.loadFile(path.join(__dirname, "renderer", "index.html"));
  });
  ipcMain.handle("nav:loadSettings", async () => {
    mainWindow?.loadFile(path.join(__dirname, "renderer", "settings.html"));
  });
  ipcMain.handle("nav:loadOnboarding", async () => {
    mainWindow?.loadFile(path.join(__dirname, "renderer", "onboarding.html"));
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Set app identity for macOS (dock name, menu bar name)
  app.setName("Quiver");

  // Dynamically set macOS dock icon if available
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, "renderer", "icon.png"));
    } catch (e) {
      console.error("Failed to set dock icon:", e);
    }
  }

  // Replace default Electron menu with Quiver menu
  const { Menu } = await import("electron");
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Quiver", submenu: [
      { role: "about", label: "About Quiver" },
      { type: "separator" },
      { role: "quit", label: "Quit Quiver" },
    ]},
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ]},
    { label: "View", submenu: [
      { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
      { role: "togglefullscreen" },
    ]},
  ]));

  // Enforce strict CSP on the renderer (US-8.1) — defense in depth alongside
  // the meta tag in index.html. Blocks external scripts/connections.
  const { session } = await import("electron");
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP_POLICY],
      },
    });
  });

  registerIpcHandlers();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Epic 1 stage 1: a daemon-owned agent deliberately survives here — the
  // session is where you left it when the window reopens. Only a legacy
  // directly-owned child is killed with its window.
  if (agentProcess) {
    agentProcess.kill();
  }
  daemonUnsub?.();
  daemonUnsub = null;
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Same deliberate survival on app quit: the daemon keeps the agent and
  // the event ring; the next launch attaches and replays.
  if (agentProcess) {
    agentProcess.kill();
  }
  daemonUnsub?.();
  daemonUnsub = null;
});
