import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn, ChildProcess } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";
import { config } from "../src/config.ts";

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
  browserHeadless: boolean;
  requireApprovalFor: string[];
  maxContextTokens: number;
  memoryDir: string;
  skillsDir: string;
  cloudSyncPath: string;
}

// ─── Globals ─────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let agentProcess: ChildProcess | null = null;

// ─── Config Persistence ───────────────────────────────────────────────

const CONFIG_FILE = path.join(app.getPath("userData"), "quiver-config.json");

const DEFAULT_CONFIG: QuiverConfig = {
  workspacePath: process.cwd(),
  provider: {
    baseUrl: config.llmBaseUrl,
    modelName: config.llmModelName,
    apiKey: "",
  },
  parallelApiKey: "",
  ollamaApiKey: "",
  githubToken: "",
  browserHeadless: true,
  requireApprovalFor: ["run_command", "write_file", "replace_content", "browser_control", "create_tool"],
  maxContextTokens: config.maxContextTokens,
  memoryDir: "./memory",
  skillsDir: "./skills",
  cloudSyncPath: "",
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
      BROWSER_HEADLESS: config.browserHeadless ? "true" : "false",
      REQUIRE_APPROVAL_FOR: config.requireApprovalFor.join(","),
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

async function startAgent(config: QuiverConfig, resumeLatest: boolean = false): Promise<void> {
  if (agentProcess) {
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
    BROWSER_HEADLESS: config.browserHeadless ? "true" : "false",
    REQUIRE_APPROVAL_FOR: config.requireApprovalFor.join(","),
    QUIVER_MAX_CONTEXT_TOKENS: String(config.maxContextTokens),
    QUIVER_CLOUD_SYNC_PATH: config.cloudSyncPath || "",
    QUIVER_OUTPUT_MODE: "json", // GUI uses JSON mode for structured IPC
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

  agentProcess = spawn(cmd, finalArgs, {
    cwd: workingDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  agentProcess.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        mainWindow?.webContents.send("agent:event", msg);
      } catch {
        // Non-JSON output — forward as raw
        mainWindow?.webContents.send("agent:raw", line);
      }
    }
  });

  agentProcess.stderr?.on("data", (data: Buffer) => {
    mainWindow?.webContents.send("agent:stderr", data.toString());
  });

  agentProcess.on("exit", (code) => {
    mainWindow?.webContents.send("agent:exit", { code });
    agentProcess = null;
  });
}

function sendToAgent(text: string): void {
  if (!agentProcess || !agentProcess.stdin) {
    mainWindow?.webContents.send("agent:error", {
      message: "Agent is not running",
    });
    return;
  }
  agentProcess.stdin.write(text + "\n");
}

function approveToolCall(approve: boolean, note?: string): void {
  if (!agentProcess || !agentProcess.stdin) return;
  // "y" approves. "n" denies; an optional revision note is sent as a second
  // line so the agent can feed concrete revision guidance back to the model
  // (US-2.4 Request-revision flow).
  agentProcess.stdin.write((approve ? "y" : "n") + "\n");
  if (!approve) {
    agentProcess.stdin.write((note ? note : "") + "\n");
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
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, name), content, "utf8");
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
        results.push({
          sessionId: state.sessionId || f.replace(".state.json", ""),
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

async function deleteSessionFile(filePath: string): Promise<boolean> {
  try {
    const fs = await import("fs/promises");
    await fs.unlink(filePath);
    // Also try to delete corresponding JSON log if exists
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
  ipcMain.handle("config:load", async () => loadConfig());
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
    if (agentProcess) {
      agentProcess.kill();
      agentProcess = null;
    }
    return true;
  });

  // Sessions
  ipcMain.handle("sessions:list", async () => listSessions());
  ipcMain.handle("sessions:load", async (_evt, filePath: string) => loadSessionFile(filePath));
  ipcMain.handle("sessions:delete", async (_evt, filePath: string) => deleteSessionFile(filePath));
  ipcMain.handle("sessions:touch", async (_evt, filePath: string) => touchSessionFile(filePath));

  // Memory
  ipcMain.handle("memory:list", async () => listMemoryFiles());
  ipcMain.handle("memory:save", async (_evt, name: string, content: string) =>
    saveMemoryFile(name, content),
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
        identity: "You are Quiver, a self-evolving coding and research assistant running in the terminal.",
        human_context: "",
        project_context: "This workspace is an agent harness containing TS tools, test runners, and configuration."
      };
    }
  });
  ipcMain.handle("memory:saveCore", async (_evt, coreMemory: any) => {
    const config = await loadConfig();
    const memoryFile = path.join(app.getPath("home"), ".quiver", "core.json");
    try {
      const fs = await import("fs/promises");
      await fs.mkdir(path.dirname(memoryFile), { recursive: true });
      await fs.writeFile(memoryFile, JSON.stringify(coreMemory, null, 2), "utf8");
      return true;
    } catch {
      return false;
    }
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
    try {
      const fs = await import("fs/promises");
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
  if (agentProcess) {
    agentProcess.kill();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (agentProcess) {
    agentProcess.kill();
  }
});
