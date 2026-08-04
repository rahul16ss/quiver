import { app } from "electron";
import * as path from "path";
import * as crypto from "crypto";
import { spawn, ChildProcess } from "child_process";
import { redactSecrets } from "../../src/security/secrets.ts";
import {
  connectOrLaunch,
  daemonStatus,
  startAgentViaDaemon,
  sendLine,
  stopAgent as stopAgentViaDaemon,
  subscribe,
  type DaemonConnection,
  type AgentEventEntry,
} from "../../src/daemon/client.ts";
import {
  getQuiverInstallDir,
  getWorkingDir,
  ensureWorkingDir,
  syncToEnv,
  type QuiverConfig,
} from "./config.ts";
import { excludedMemories } from "./memory.ts";
import { PROJECT_ROOT } from "./paths.ts";
import { getMainWindow } from "./windows-state.ts";

let agentProcess: ChildProcess | null = null;
let daemonConn: DaemonConnection | null = null;
let daemonUnsub: (() => void) | null = null;
let lastEventSeq = 0;
let agentViaDaemon = false;
let replayCutoffSeq = 0;

export function getAgentProcess(): ChildProcess | null {
  return agentProcess;
}

export function isAgentViaDaemon(): boolean {
  return agentViaDaemon;
}

export function getDaemonConnection(): DaemonConnection | null {
  return daemonConn;
}

function getAgentCommand(): { cmd: string; args: string[] } {
  if (app.isPackaged) {
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
  const cliPath = path.join(PROJECT_ROOT, "src", "cli.ts");
  const tsxBin = path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx");
  return {
    cmd: tsxBin,
    args: [cliPath, "--json"],
  };
}

function getDaemonCommand(): { cmd: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    return {
      cmd: "node",
      args: ["--import", "tsx", path.join(process.resourcesPath, "src", "daemon", "daemon.ts")],
      cwd: process.resourcesPath,
    };
  }
  return {
    cmd: path.join(PROJECT_ROOT, "node_modules", ".bin", "tsx"),
    args: [path.join(PROJECT_ROOT, "src", "daemon", "daemon.ts")],
    cwd: PROJECT_ROOT,
  };
}

function configLabel(env: Record<string, string | undefined>, cwd: string, args: string[]): string {
  const material = JSON.stringify({
    cwd,
    args,
    env: {
      LLM_API_BASE_URL: env.LLM_API_BASE_URL,
      LLM_MODEL_NAME: env.LLM_MODEL_NAME,
      VERTEX_PROJECT_ID: env.VERTEX_PROJECT_ID,
      VERTEX_LOCATION: env.VERTEX_LOCATION,
      CHECKER_LLM_MODEL_NAME: env.CHECKER_LLM_MODEL_NAME,
      QUIVER_AUTONOMY: env.QUIVER_AUTONOMY,
      QUIVER_MAX_CONTEXT_TOKENS: env.QUIVER_MAX_CONTEXT_TOKENS,
      QUIVER_PROFILE: env.QUIVER_PROFILE,
      QUIVER_CONSENT_GATE: env.QUIVER_CONSENT_GATE,
      QUIVER_PROTECTED_DIR: env.QUIVER_PROTECTED_DIR,
    },
  });
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function forwardDaemonEntry(entry: AgentEventEntry): void {
  lastEventSeq = entry.seq;
  const mainWindow = getMainWindow();
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
      mainWindow?.webContents.send("agent:stderr", redactSecrets(entry.payload));
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
      if (entry.seq <= replayCutoffSeq) {
        mainWindow?.webContents.send("agent:event", {
          type: "user_replay",
          content: entry.payload,
        });
      }
      break;
    case "stopped":
      break;
  }
}

function subscribeToDaemon(fromSeq: number): void {
  if (!daemonConn) return;
  daemonUnsub?.();
  daemonUnsub = subscribe(daemonConn, fromSeq, forwardDaemonEntry, () => {
    daemonUnsub = null;
    if (agentViaDaemon) {
      agentViaDaemon = false;
      daemonConn = null;
      getMainWindow()?.webContents.send("agent:exit", { code: null });
    }
  });
}

export async function startAgent(config: QuiverConfig, resumeLatest: boolean = false): Promise<void> {
  if (agentProcess) {
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
    LLM_API_KEY: config.llmApiKey || config.provider.apiKey,
    PARALLEL_API_KEY: config.parallelApiKey,
    VERTEX_PROJECT_ID: config.vertexProjectId || "",
    VERTEX_LOCATION: config.vertexLocation || "global",
    GOOGLE_APPLICATION_CREDENTIALS: config.googleApplicationCredentials || "",
    CHECKER_LLM_MODEL_NAME: config.checkerModelName || "",
    QUIVER_AUTONOMY: config.autonomyGrants || "",
    QUIVER_MAX_CONTEXT_TOKENS: String(config.maxContextTokens),
    QUIVER_OUTPUT_MODE: "json",
    QUIVER_PROFILE: config.profile || "",
    QUIVER_EXCLUDED_MEMORIES: [...excludedMemories].join(","),
    QUIVER_CONSENT_GATE:
      config.consentGateEnabled ||
      (config.profile === "finance-client" &&
        process.env.QUIVER_CONSENT_GATE !== "0")
        ? "1"
        : "0",
    QUIVER_PROTECTED_DIR: getQuiverInstallDir(),
  };
  if ((config.vertexProjectId || "").trim()) {
    (env as Record<string, string>).QUIVER_CHECKER_REMOTE_APPROVED = "1";
  }

  if (app.isPackaged) {
    (env as Record<string, string>).APP_ROOT = process.resourcesPath;
  }

  const workingDir = getWorkingDir(config);
  await ensureWorkingDir(workingDir);
  await syncToEnv(config);

  const label = configLabel(env, workingDir, finalArgs);
  try {
    daemonConn = await connectOrLaunch(getDaemonCommand());
    const status = await daemonStatus(daemonConn);
    lastEventSeq = 0;
    replayCutoffSeq = status.lastSeq;
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
        getMainWindow()?.webContents.send("agent:event", msg);
      } catch {
        getMainWindow()?.webContents.send("agent:raw", line);
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    getMainWindow()?.webContents.send("agent:stderr", redactSecrets(data.toString()));
  });

  proc.on("exit", (code) => {
    if ((proc as any)._expectedExit) {
      if (agentProcess === proc) agentProcess = null;
      return;
    }
    getMainWindow()?.webContents.send("agent:exit", { code });
    if (agentProcess === proc) agentProcess = null;
  });

  agentProcess = proc;
}

export function sendToAgent(text: string): void {
  if (agentViaDaemon && daemonConn) {
    void sendLine(daemonConn, text, "user").then((ok) => {
      if (!ok) {
        getMainWindow()?.webContents.send("agent:error", { message: "Agent is not running" });
      }
    });
    return;
  }
  if (!agentProcess || !agentProcess.stdin) {
    getMainWindow()?.webContents.send("agent:error", {
      message: "Agent is not running",
    });
    return;
  }
  agentProcess.stdin.write(text + "\n");
}

export function approveToolCall(approve: boolean, note?: string): void {
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

export async function stopAgent(): Promise<void> {
  if (agentViaDaemon && daemonConn) {
    await stopAgentViaDaemon(daemonConn).catch(() => {});
  }
  if (agentProcess) {
    agentProcess.kill();
    agentProcess = null;
  }
}

export function sendConsentDecision(token: string): { sent: boolean } {
  if (agentViaDaemon && daemonConn) {
    void sendLine(daemonConn, token).then((ok) => {
      if (!ok) getMainWindow()?.webContents.send("agent:error", { message: "Agent is not running" });
    });
    return { sent: true };
  }
  if (!agentProcess || !agentProcess.stdin) return { sent: false };
  agentProcess.stdin.write(token + "\n");
  return { sent: true };
}

export function cleanupAgentOnWindowClose(): void {
  if (agentProcess) {
    agentProcess.kill();
  }
  daemonUnsub?.();
  daemonUnsub = null;
}

export function cleanupAgentOnQuit(): void {
  if (agentProcess) {
    agentProcess.kill();
  }
  daemonUnsub?.();
  daemonUnsub = null;
}
