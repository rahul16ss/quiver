import { app } from "electron";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { loadConfig } from "./config.ts";

const execAsync = promisify(exec);

export async function findOfficeCliBinary(): Promise<string | null> {
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

export async function runWorkspaceTests(): Promise<{ success: boolean; output: string }> {
  const config = await loadConfig();
  const workspaceDir = config.workspacePath || process.cwd();
  try {
    const { stdout, stderr } = await execAsync("npm test", { cwd: workspaceDir });
    return { success: true, output: stdout || stderr };
  } catch (err: any) {
    return { success: false, output: err.stdout || err.stderr || err.message };
  }
}

export async function listSkills(workspacePath: string, skillsDirConfig: string): Promise<string[]> {
  try {
    const fs = await import("fs/promises");
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

export async function readSkillFile(skillName: string): Promise<string | null> {
  const fs = await import("fs/promises");
  const { resolveAndAssertPathAllowed, createDefaultPolicy } = await import("../../src/security/path_policy.ts");
  const globalSkillsDir = path.join(app.getPath("home"), ".quiver", "skills");
  const skillDir = path.join(globalSkillsDir, skillName);
  const skillFile = path.join(skillDir, "SKILL.md");
  try {
    resolveAndAssertPathAllowed(skillFile, "read", createDefaultPolicy(globalSkillsDir));
  } catch {
    return null;
  }
  try {
    return await fs.readFile(skillFile, "utf8");
  } catch {
    try {
      const standalone = path.resolve(globalSkillsDir, skillName);
      resolveAndAssertPathAllowed(standalone, "read", createDefaultPolicy(globalSkillsDir));
      return await fs.readFile(standalone, "utf8");
    } catch {
      return null;
    }
  }
}

export async function saveSkillFile(skillName: string, content: string): Promise<boolean> {
  const fs = await import("fs/promises");
  const { resolveAndAssertPathAllowed, createDefaultPolicy } = await import("../../src/security/path_policy.ts");
  const globalSkillsDir = path.join(app.getPath("home"), ".quiver", "skills");
  const skillDir = path.join(globalSkillsDir, skillName);
  const skillFile = path.join(skillDir, "SKILL.md");
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
}

export async function rerunWorkflow(demoRoot: string): Promise<{ success: boolean; output: string; checks: number }> {
  try {
    const { stdout, stderr } = await execAsync("npm run demo:ic-memo", {
      cwd: demoRoot,
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const checks = (stdout.match(/\[PASS\]/g) || []).length;
    return { success: true, output: stdout || stderr, checks };
  } catch (err: any) {
    return { success: false, output: err.stdout || err.stderr || err.message, checks: 0 };
  }
}

export async function previewFile(
  filePath: string,
  ipcPathGuard: (filePath: string, op: "read" | "write") => string | null,
): Promise<any> {
  try {
    const guardErr = ipcPathGuard(filePath, "read");
    if (guardErr) return { error: guardErr };
    const fs = await import("fs/promises");
    const ext = path.extname(filePath).toLowerCase();
    const stat = await fs.stat(filePath);
    if (stat.size > 10 * 1024 * 1024) {
      return { error: "File too large to preview (>10MB)", type: ext };
    }

    if (ext === ".docx" || ext === ".xlsx" || ext === ".pptx") {
      try {
        const { execFile } = await import("child_process");
        const { promisify: p } = await import("util");
        const execFileAsync = p(execFile);
        const officecliBin = await findOfficeCliBinary();
        if (officecliBin) {
          const { stdout } = await execFileAsync(officecliBin, [
            "view", filePath, "--mode", "text",
          ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
          return { content: stdout, type: ext, officeDoc: true };
        }
      } catch {
        // OfficeCLI not available
      }
      return { error: "Office documents can't be previewed yet. The Office engine isn't installed; it installs automatically the first time Quiver creates a document.", type: ext };
    }

    const textExts = [".md", ".txt", ".json", ".js", ".ts", ".tsx", ".jsx",
      ".css", ".html", ".xml", ".yaml", ".yml", ".csv", ".tsv", ".py",
      ".rs", ".go", ".java", ".c", ".cpp", ".h", ".sh", ".sql", ".env",
      ".toml", ".ini", ".cfg", ".log", ".diff", ".patch"];
    if (textExts.includes(ext) || ext === "") {
      const content = await fs.readFile(filePath, "utf8");
      return { content, type: ext || ".txt" };
    }

    const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico"];
    if (imageExts.includes(ext)) {
      return { imageUrl: `file://${filePath}`, type: ext, isImage: true };
    }

    if (ext === ".pdf") {
      return { pdfUrl: `file://${filePath}`, type: ext, isPdf: true };
    }

    return { error: `Cannot preview ${ext} files`, type: ext };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { error: "This file hasn't been created yet." };
    return { error: err.message || "Couldn't preview this file." };
  }
}

export async function loadEvidence(docFilePath: string, ipcPathGuard: (filePath: string, op: "read" | "write") => string | null): Promise<any> {
  try {
    const guardErr = ipcPathGuard(docFilePath, "read");
    if (guardErr) return { error: guardErr };
    const fs = await import("fs/promises");
    const { validateEvidenceFile } = await import("../../src/evidence/tracker.ts");
    const baseName = path.basename(docFilePath).replace(/\.(docx|xlsx|pptx)$/, "");
    const dir = path.dirname(docFilePath);
    const evidencePath = path.join(dir, `${baseName}_Evidence.json`);
    try {
      await fs.readFile(evidencePath, "utf8");
    } catch {
      return {
        docPath: docFilePath,
        valid: false,
        missing: true,
        evidencePath,
        problems: [`Evidence file is missing: ${evidencePath}`],
        claims: [],
        sources: [],
        sourcesExcluded: [],
        runRecord: null,
      };
    }
    const validation = await validateEvidenceFile(docFilePath);
    if (!validation.valid || !validation.model) {
      return {
        docPath: docFilePath,
        valid: false,
        missing: validation.missing,
        evidencePath: validation.evidencePath,
        problems: validation.problems,
        claims: [],
        sources: [],
        sourcesExcluded: [],
        runRecord: null,
      };
    }
    const model = validation.model;
    let runRecord: any = null;
    try {
      const runRecordPath = path.join(dir, `${baseName}_Run_Record.json`);
      const runRaw = await fs.readFile(runRecordPath, "utf8");
      runRecord = JSON.parse(runRaw);
    } catch {
      // No run record
    }
    return {
      docPath: docFilePath,
      valid: true,
      missing: false,
      evidencePath: validation.evidencePath,
      claims: model.claims || [],
      sources: model.sources || [],
      sourcesExcluded: model.sources_excluded || [],
      reviewStatus: model.review_status || "draft_for_review",
      title: model.title || "",
      company: model.company || "",
      asOf: model.as_of || "",
      runRecord,
    };
  } catch {
    return null;
  }
}
