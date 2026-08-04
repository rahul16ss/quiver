import { app } from "electron";
import * as path from "path";
import * as fsSync from "fs";
import { createDefaultPolicy } from "../../src/security/path_policy.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { PROJECT_ROOT } from "./paths.ts";

export function getProjectSessionsDir(workspacePath: string): string {
  let projectName: string;
  if (workspacePath) {
    projectName = path.basename(workspacePath);
  } else if (!app.isPackaged) {
    projectName = path.basename(PROJECT_ROOT);
  } else {
    projectName = path.basename(process.cwd()) || "default";
  }
  return path.join(app.getPath("home"), ".quiver", "projects", projectName, ".sessions");
}

export async function listSessions(): Promise<any[]> {
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
          text = text.replace(/\[File:[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
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
      } catch (error: any) {
        results.push({
          sessionId: f.replace(".state.json", ""),
          title: "Corrupt session state",
          path: path.join(sessionsDir, f),
          savedAt: "CORRUPT",
          messageCount: 0,
          model: "CORRUPT",
          error: error?.message || "Session state could not be parsed.",
        });
      }
    }
    results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    return results;
  } catch {
    return [];
  }
}

export async function loadSessionFile(filePath: string): Promise<any> {
  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
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

export async function deleteSessionFile(filePath: string, permanent: boolean = false): Promise<boolean> {
  if (permanent) {
    return permanentlyDeleteSessionFile(filePath);
  }
  try {
    const fs = await import("fs/promises");
    const sessionsDir = path.dirname(filePath);
    const archiveDir = path.join(sessionsDir, "archive");
    await fs.mkdir(archiveDir, { recursive: true });

    const basename = path.basename(filePath);
    const archivePath = path.join(archiveDir, basename);
    await fs.rename(filePath, archivePath);

    const logPath = filePath.replace(".state.json", ".json");
    try { await fs.rename(logPath, path.join(archiveDir, path.basename(logPath))); } catch {}
    const loglPath = filePath.replace(".state.json", ".jsonl");
    try { await fs.rename(loglPath, path.join(archiveDir, path.basename(loglPath))); } catch {}

    return true;
  } catch {
    return false;
  }
}

export async function touchSessionFile(filePath: string): Promise<boolean> {
  try {
    const fs = await import("fs/promises");
    const now = new Date();
    await fs.utimes(filePath, now, now);
    return true;
  } catch {
    return false;
  }
}

export async function sessionPathGuard(filePath: string): Promise<string | null> {
  try {
    const { getWorkingDir } = await import("./config.ts");
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
      // no workspace configured
    }
    if (!inProjects && !inWorkspace) return "Path is outside the session stores";
    return null;
  } catch (e: any) {
    return e?.message || "Invalid session path";
  }
}

export function sessionPolicyFor(filePath: string) {
  return createDefaultPolicy(path.dirname(path.resolve(filePath)));
}
