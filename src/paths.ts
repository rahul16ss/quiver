/**
 * Path resolution for Quiver — global identity + per-project context.
 *
 * Architecture:
 *   ~/.quiver/                  ← Global (shared across all projects)
 *   ├── core.json               ← Identity, human context (who you are)
 *   ├── skills/                 ← Global skills (reusable procedures)
 *   └── projects/               ← Per-project data
 *       ├── {projectName}/      ← Project-specific
 *       │   ├── memory/         ← Project memory (persona, notes)
 *       │   └── .sessions/      ← Project session logs + state
 *
 * The project name is derived from the current working directory's
 * basename (e.g. ~/projects/my-app → "my-app").
 * Override with QUIVER_PROJECT_NAME env var.
 *
 * For backwards compatibility, if ~/.quiver/ doesn't exist but
 * ./memory/ does (legacy local mode), use the local directory.
 */

import * as path from "path";
import * as os from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import * as crypto from "crypto";

const GLOBAL_ROOT = path.join(os.homedir(), ".quiver");

/**
 * Get the project name from CWD basename or env var.
 */
export function getProjectName(): string {
  if (process.env.QUIVER_PROJECT_NAME) {
    return process.env.QUIVER_PROJECT_NAME;
  }
  return path.basename(process.cwd()) || "default";
}

/**
 * Global root directory (~/.quiver/).
 * Shared across all projects: core identity, skills.
 */
export function getGlobalRoot(): string {
  return GLOBAL_ROOT;
}

/**
 * Per-project root directory (~/.quiver/projects/{projectName}/).
 * Contains project-specific memory and sessions.
 */
export function getProjectRoot(): string {
  return path.join(GLOBAL_ROOT, "projects", getProjectName());
}

/**
 * Stable project identifier (US-1.2). A UUID is generated once per project
 * directory and persisted in `~/.quiver/projects/{projectName}/project.json`,
 * so the canonical project id survives renames of the working directory's
 * basename (the human-readable folder name is kept for readability only).
 */
export function getProjectId(): string {
  const root = getProjectRoot();
  const idFile = path.join(root, "project.json");
  try {
    if (existsSync(idFile)) {
      const data = JSON.parse(readFileSync(idFile, "utf8"));
      if (data && typeof data.project_id === "string" && data.project_id) {
        return data.project_id;
      }
    }
  } catch {
    // fall through to generation
  }
  const project_id = crypto.randomUUID();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(idFile, JSON.stringify({
      project_id,
      display_name: getProjectName(),
      workspace_path: process.cwd(),
      description: "",
      created_at: new Date().toISOString(),
    }, null, 2), "utf8");
  } catch {
    // best-effort persistence
  }
  return project_id;
}

/**
 * Global core memory file (~/.quiver/core.json).
 * Contains identity and human context — shared across all projects.
 */
export function getCoreMemoryPath(): string {
  return path.join(GLOBAL_ROOT, "core.json");
}

/**
 * Global skills directory (~/.quiver/skills/).
 * Skills are reusable procedures, not project-specific.
 */
export function getSkillsDir(): string {
  // Check if global skills dir exists, fall back to local
  const globalSkills = path.join(GLOBAL_ROOT, "skills");
  if (existsSync(globalSkills)) return globalSkills;

  // Fall back to local ./skills/ for backwards compat
  const localSkills = path.resolve(process.cwd(), "skills");
  return localSkills;
}

/**
 * Per-project memory directory (~/.quiver/projects/{projectName}/memory/).
 * Contains project-specific memory files (persona.txt, human.txt, etc.).
 */
export function getProjectMemoryDir(): string {
  return path.join(getProjectRoot(), "memory");
}

/**
 * Per-project sessions directory (~/.quiver/projects/{projectName}/.sessions/).
 * Contains session logs and state files, namespaced by project.
 */
export function getProjectSessionsDir(): string {
  return path.join(getProjectRoot(), ".sessions");
}

/**
 * Per-project generated-tools directory (~/.quiver/projects/{projectName}/tools/).
 * Holds JIT-compiled generated tool sources/binaries and approval metadata.
 * This is private local-only data (never synced to the cloud).
 */
export function getProjectToolsDir(): string {
  return path.join(getProjectRoot(), "tools");
}

/**
 * Ensure all required directories exist.
 * Called once at startup. Also seeds the global skills directory with
 * the system-prompt skill if it doesn't exist yet.
 */
export async function ensureDirectories(): Promise<void> {
  const { promises: fs } = await import("fs");
  await fs.mkdir(GLOBAL_ROOT, { recursive: true });
  await fs.mkdir(path.join(GLOBAL_ROOT, "skills"), { recursive: true });
  await fs.mkdir(getProjectMemoryDir(), { recursive: true });
  await fs.mkdir(getProjectSessionsDir(), { recursive: true });

  // Seed system-prompt skill if missing
  const globalSkillDir = path.join(GLOBAL_ROOT, "skills", "system-prompt");
  const globalSkillFile = path.join(globalSkillDir, "SKILL.md");
  if (!existsSync(globalSkillFile)) {
    // Try to copy from local ./skills/system-prompt/SKILL.md
    const localSkill = path.resolve(process.cwd(), "skills", "system-prompt", "SKILL.md");
    if (existsSync(localSkill)) {
      await fs.mkdir(globalSkillDir, { recursive: true });
      await fs.copyFile(localSkill, globalSkillFile);
    }
  }
}
