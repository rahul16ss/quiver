/**
 * Tool Path Guard — US-9.2 wiring for the real agent tools.
 *
 * Bridges the workspace PathPolicy (src/security/path_policy.ts) into the
 * file/shell tools so every filesystem operation performed by the agent is
 * canonicalized, symlink-resolved, and boundary-checked before it runs.
 *
 * Policy:
 *   - Sensitive paths (.env, *.pem, *.key, id_rsa, .git/, .ssh/, .aws/, .config/)
 *     are hard-blocked for ALL operations, regardless of location.
 *   - Reads may reach outside the workspace (the agent legitimately inspects
 *     system files), but sensitive paths remain blocked.
 *   - Writes/deletes are confined to the workspace root OR Quiver's own data
 *     home (~/.quiver, where memory/sessions/generated tools live). Anything
 *     else is refused — this is what stops an agent from writing to
 *     /etc/passwd or ~/.ssh/authorized_keys when an approval gate is bypassed.
 */

import * as path from "path";
import * as os from "os";
import { realpathSync, mkdirSync } from "fs";
import {
  resolveAndAssertPathAllowed,
  createDefaultPolicy,
  assertNotProtectedInstallDir,
  type PathPolicy,
  type ResolvedPath,
} from "./path_policy.js";
import { config } from "../config.js";
import { isScratchModeActive, resolveScratchPath, ensureScratchDir } from "./scratch_area.js";

const QUIVER_HOME = path.join(os.homedir(), ".quiver");

function isInside(candidate: string, root: string): boolean {
  // Resolve the root through realpath so it is on the same (symlink-resolved)
  // basis as the candidate (which is realpath-resolved by the path policy).
  // Without this, a workspace under a symlinked path (macOS /var -> /private/var)
  // would wrongly reject legitimate in-workspace writes.
  let normalizedRoot = root;
  try {
    normalizedRoot = realpathSync(root);
  } catch {
    normalizedRoot = path.resolve(root);
  }
  const rel = path.relative(normalizedRoot, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Assert that a tool filesystem operation is allowed by the path sandbox.
 * Throws with a user-facing reason if the path is blocked or out of bounds.
 */
export function assertToolPathAllowed(
  filePath: string,
  operation: "read" | "write" | "delete",
  workspaceRoot: string = process.cwd(),
): ResolvedPath {
  // Sandbox bypass: when the user has explicitly disabled the path sandbox
  // via /sandbox off (requires YOLO mode), skip all boundary and blocked-glob
  // checks. The agent can read/write anywhere on the filesystem.
  if (config.sandboxDisabled) {
    const absolutePath = path.resolve(filePath);
    let realPath = absolutePath;
    try { realPath = realpathSync(absolutePath); } catch {}
    // Even with the sandbox off, GUI-spawned sessions may never write into
    // Quiver's own installation tree (QUIVER_PROTECTED_DIR) — the
    // self-modification guard is not bypassable from the app (Epic 2 §2.5).
    assertNotProtectedInstallDir(realPath, operation);
    return { inputPath: filePath, absolutePath, realPath, insideWorkspace: false };
  }
  // Build the path policy. Reads are gated by the active trust tier's
  // readScope (US-6.4): "workspace" confines reads to the project, "home"
  // permits workspace + user home, "filesystem" allows anywhere (minus
  // blocked globs + sensitive home paths). Writes are always workspace-
  // confined here; the YOLO sandbox-off bypass returns early above.
  const policy: PathPolicy = createDefaultPolicy(workspaceRoot);
  policy.readScope = (config.readScope ?? "filesystem") as any;
  // allowOutsideWorkspace is only relevant for write/delete outside workspace;
  // for reads the readScope gate in path_policy.ts handles the boundary.
  policy.allowOutsideWorkspace = false;

  // resolveAndAssertPathAllowed throws on blocked globs / sensitive home paths.
  const resolved = resolveAndAssertPathAllowed(filePath, operation, policy);

  if (operation === "write" || operation === "delete") {
    const insideWorkspace = isInside(resolved.realPath, path.resolve(workspaceRoot));
    const insideQuiver = isInside(resolved.realPath, QUIVER_HOME);
    if (!insideWorkspace && !insideQuiver) {
      throw new Error(
        `Refusing to ${operation} '${filePath}' — it resolves outside the workspace ` +
          `('${workspaceRoot}') and outside Quiver's data home ('${QUIVER_HOME}'). ` +
          `Filesystem writes are sandboxed to the project workspace.`,
      );
    }

    // ── Scratch-area semantics (US-17.14) ──
    // When the active trust tier is "build" (buyer-facing: "Draft & research"),
    // redirect writes to .quiver/scratch/ so the user can review and promote.
    // This does NOT apply to:
    //   - Files already inside .quiver/ (memory, sessions, tools)
    //   - Files inside ~/.quiver (Quiver's data home)
    //   - Deletes (we don't redirect deletes, only writes)
    if (operation === "write" && isScratchModeActive() && insideWorkspace) {
      const scratchPath = resolveScratchPath(resolved.realPath, workspaceRoot);
      if (scratchPath) {
        ensureScratchDir(workspaceRoot);
        const scratchParent = path.dirname(scratchPath);
        try { mkdirSync(scratchParent, { recursive: true }); } catch {}
        return {
          inputPath: filePath,
          absolutePath: scratchPath,
          realPath: scratchPath,
          insideWorkspace: true,
        };
      }
    }
  }

  return resolved;
}

/**
 * Non-throwing variant for cases where the tool wants to return a clean error
 * string to the model rather than throw.
 */
export function checkToolPathAllowed(
  filePath: string,
  operation: "read" | "write" | "delete",
  workspaceRoot?: string,
): string | null {
  try {
    assertToolPathAllowed(filePath, operation, workspaceRoot);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

export { QUIVER_HOME };
