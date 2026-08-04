import { app } from "electron";
import * as path from "path";
import { resolveAndAssertPathAllowed, createDefaultPolicy } from "../../src/security/path_policy.ts";
import { loadConfig } from "./config.ts";
import { PROJECT_ROOT } from "./paths.ts";

export const excludedMemories: Set<string> = new Set();

export function getProjectMemoryDir(workspacePath: string): string {
  let projectName: string;
  if (workspacePath) {
    projectName = path.basename(workspacePath);
  } else if (!app.isPackaged) {
    projectName = path.basename(PROJECT_ROOT);
  } else {
    projectName = path.basename(process.cwd()) || "default";
  }
  return path.join(app.getPath("home"), ".quiver", "projects", projectName, "memory");
}

export async function listMemoryFiles(): Promise<
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

export async function saveMemoryFile(name: string, content: string): Promise<boolean> {
  try {
    const config = await loadConfig();
    const fs = await import("fs/promises");
    const memDir = getProjectMemoryDir(config.workspacePath || process.cwd());
    const targetFile = path.join(memDir, name);
    resolveAndAssertPathAllowed(targetFile, "write", createDefaultPolicy(memDir));
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(targetFile, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function deleteMemoryFile(name: string): Promise<boolean> {
  try {
    const config = await loadConfig();
    const fs = await import("fs/promises");
    const memDir = getProjectMemoryDir(config.workspacePath || process.cwd());
    const filePath = path.join(memDir, name);
    resolveAndAssertPathAllowed(filePath, "delete", createDefaultPolicy(memDir));
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export function toggleExcludedMemory(memoryName: string): string[] {
  if (excludedMemories.has(memoryName)) {
    excludedMemories.delete(memoryName);
  } else {
    excludedMemories.add(memoryName);
  }
  return [...excludedMemories];
}

export async function loadCoreMemory(): Promise<any> {
  const memoryFile = path.join(app.getPath("home"), ".quiver", "core.json");
  try {
    const fs = await import("fs/promises");
    const content = await fs.readFile(memoryFile, "utf8");
    return JSON.parse(content);
  } catch {
    return {
      identity:
        "Prefer concise, source-backed drafts suitable for analysts, researchers, consultants, and legal professionals. Never invent facts or sources.",
      human_context: "",
      project_context: "",
    };
  }
}

export async function saveCoreMemory(coreMemory: any): Promise<boolean> {
  const memoryFile = path.join(app.getPath("home"), ".quiver", "core.json");
  try {
    const fs = await import("fs/promises");
    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, JSON.stringify(coreMemory, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
