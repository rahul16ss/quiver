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
 * basename (e.g. /Users/rahul/ValuClaw → "ValuClaw").
 * Override with QUIVER_PROJECT_NAME env var.
 *
 * For backwards compatibility, if ~/.quiver/ doesn't exist but
 * ./memory/ does (legacy local mode), use the local directory.
 */

import * as path from "path";
import * as os from "os";
import { existsSync } from "fs";

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
