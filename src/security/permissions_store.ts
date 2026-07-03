/**
 * Per-Project Permissions Store — US-6.4
 *
 * Persists the active trust tier (and any raw grant overrides) per project so
 * autonomy settings are scoped to the workspace, not global to the process.
 * Stored under ~/.quiver/projects/<projectId>/permissions.json.
 *
 * The runtime source of truth remains `config.autonomyGrants`; this module
 * loads/saves the persisted tier so a session resumes with the permissions the
 * user chose for *this* project, and a different project keeps its own scope.
 */

import * as path from "path";
import * as os from "os";
import { promises as fs, existsSync } from "fs";
import { getProjectId } from "../paths.js";
import type { TrustTier } from "../config.js";

export interface PersistedPermissions {
  tier: TrustTier | null;
  /** Raw grant overrides applied on top of the tier (optional). */
  grantOverrides?: string[];
  savedAt: string;
}

function storePath(): string {
  return path.join(
    os.homedir(),
    ".quiver",
    "projects",
    getProjectId(),
    "permissions.json",
  );
}

/**
 * Load persisted permissions for the current project. Returns null if no
 * preferences have been saved (first run / legacy).
 */
export async function loadPermissions(): Promise<PersistedPermissions | null> {
  try {
    const p = storePath();
    if (!existsSync(p)) return null;
    const raw = await fs.readFile(p, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return {
      tier: data.tier ?? null,
      grantOverrides: Array.isArray(data.grantOverrides)
        ? data.grantOverrides
        : undefined,
      savedAt: data.savedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Persist permissions for the current project.
 */
export async function savePermissions(
  tier: TrustTier | null,
  grantOverrides?: string[],
): Promise<void> {
  try {
    const p = storePath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    const data: PersistedPermissions = {
      tier,
      grantOverrides,
      savedAt: new Date().toISOString(),
    };
    await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Best-effort — never block the session on persistence.
  }
}
