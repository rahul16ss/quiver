import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────

interface ProviderConfig {
  baseUrl: string;
  modelName: string;
  apiKey: string;
}

interface QuiverConfig {
  provider: ProviderConfig;
  parallelApiKey: string;
  ollamaApiKey: string;
  githubToken: string;
  context7ApiKey: string;
  browserHeadless: boolean;
  requireApprovalFor: string[];
  maxContextTokens: number;
  memoryDir: string;
  skillsDir: string;
}

// ─── Globals ─────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let agentProcess: ChildProcess | null = null;

// ─── Config Persistence ───────────────────────────────────────────────

const CONFIG_FILE = path.join(app.getPath("userData"), "quiver-config.json");

const DEFAULT_CONFIG: QuiverConfig = {
  provider: {
    baseUrl: "https://ollama.com/v1",
    modelName: "glm-5.2:cloud",
    apiKey: "",
  },
  parallelApiKey: "",
  ollamaApiKey: "",
  githubToken: "",
  context7ApiKey: "",
  browserHeadless: true,
  requireApprovalFor: [
    "run_command",
    "write_file",
    "replace_content",
    "browser_control",
    "create_tool",
  ],
  maxContextTokens: 120000,
  memoryDir: "./memory",
  skillsDir: "./skills",
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

// ─── .env Sync ───────────────────────────────────────────────────────
// Writes config values back to the project .env so the CLI and GUI stay in sync.

async function syncToEnv(config: QuiverConfig): Promise<void> {
  try {
    const fs = await import("fs/promises");
    const envPath = path.resolve(process.cwd(), ".env");
    let envContent = "";

    try {
      envContent = await fs.readFile(envPath, "utf8");
    } catch {
      // No .env yet — start from example
      try {
        envContent = await fs.readFile(
          path.resolve(process.cwd(), ".env.example"),
          "utf8",
        );
      } catch {
        envContent = "";
      }
    }

    const replacements: Record<string, string> = {
      LLM_API_BASE_URL: config.provider.baseUrl,
      LLM_MODEL_NAME: config.provider.modelName,
      LLM_API_KEY: config.provider.apiKey,
      PARALLEL_API_KEY: config.parallelApiKey,
      OLLAMA_API_KEY: config.ollamaApiKey,
      GITHUB_TOKEN: config.githubToken,
      CONTEXT7_API_KEY: config.context7ApiKey,
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

function startAgent(config: QuiverConfig): void {
  if (agentProcess) {
    agentProcess.kill();
    agentProcess = null;
  }

  const cwd = process.cwd();
  const env = {
    ...process.env,
    LLM_API_BASE_URL: config.provider.baseUrl,
    LLM_MODEL_NAME: config.provider.modelName,
    LLM_API_KEY: config.provider.apiKey,
    PARALLEL_API_KEY: config.parallelApiKey,
    OLLAMA_API_KEY: config.ollamaApiKey,
    GITHUB_TOKEN: config.githubToken,
    CONTEXT7_API_KEY: config.context7ApiKey,
    BROWSER_HEADLESS: config.browserHeadless ? "true" : "false",
    REQUIRE_APPROVAL_FOR: config.requireApprovalFor.join(","),
    QUIVER_MAX_CONTEXT_TOKENS: String(config.maxContextTokens),
    QUIVER_OUTPUT_MODE: "json", // GUI uses JSON mode for structured IPC
  };

  agentProcess = spawn("npx", ["tsx", "src/cli.ts", "--json"], {
    cwd,
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

function approveToolCall(approve: boolean): void {
  if (!agentProcess || !agentProcess.stdin) return;
  agentProcess.stdin.write((approve ? "y" : "n") + "\n");
}

// ─── Memory File Management ──────────────────────────────────────────

async function listMemoryFiles(): Promise<
  { name: string; content: string; size: number }[]
> {
  try {
    const fs = await import("fs/promises");
    const memDir = path.resolve(process.cwd(), "memory");
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
    const fs = await import("fs/promises");
    const memDir = path.resolve(process.cwd(), "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, name), content, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ─── Window Management ────────────────────────────────────────────────

async function createWindow(): Promise<void> {
  const configured = await isConfigured();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Quiver",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
  ipcMain.handle("agent:start", async (_evt, config: QuiverConfig) => {
    await syncToEnv(config);
    startAgent(config);
    return true;
  });
  ipcMain.handle("agent:send", async (_evt, text: string) => {
    sendToAgent(text);
    return true;
  });
  ipcMain.handle("agent:approve", async (_evt, approve: boolean) => {
    approveToolCall(approve);
    return true;
  });
  ipcMain.handle("agent:stop", async () => {
    if (agentProcess) {
      agentProcess.kill();
      agentProcess = null;
    }
    return true;
  });

  // Memory
  ipcMain.handle("memory:list", async () => listMemoryFiles());
  ipcMain.handle("memory:save", async (_evt, name: string, content: string) =>
    saveMemoryFile(name, content),
  );

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
