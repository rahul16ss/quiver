/**
 * Workspace Path Sandbox — US-9.2
 *
 * All filesystem operations are constrained by policy. Before any file access,
 * Quiver canonicalizes paths, resolves symlinks, and verifies the target path
 * resolves inside the approved workspace root.
 *
 * Sensitive files are blocked by default. Attempts outside the workspace are
 * blocked unless the user explicitly approves.
 */

import * as path from "path";
import * as os from "os";
import { realpathSync, existsSync } from "fs";

// ─── Types ───────────────────────────────────────────────────────────

export type ReadScope = "workspace" | "home" | "filesystem";

export interface PathPolicy {
  workspaceRoot: string;
  /** Whether reads/writes may reach outside the workspace root. */
  allowOutsideWorkspace: boolean;
  /**
   * Filesystem read scope (US-6.4). Controls how far *reads* may reach:
   *   "workspace"  — only the project workspace
   *   "home"       — workspace + user home (non-sensitive paths)
   *   "filesystem" — anywhere except blocked globs (legacy default)
   * Writes are always confined to the workspace (or ~/.quiver) unless the
   * sandbox is disabled, regardless of read scope.
   */
  readScope: ReadScope;
  blockedGlobs: string[];
  /** Whitelist globs for reads inside the workspace (empty = allow all). */
  readAllowGlobs: string[];
  /** Whitelist globs for writes inside the workspace (empty = allow all). */
  writeAllowGlobs: string[];
}

export interface ResolvedPath {
  inputPath: string;
  absolutePath: string;
  realPath: string;
  insideWorkspace: boolean;
}

// ─── Default Blocked Paths ───────────────────────────────────────────

/**
 * Global blocked paths — these are never accessible regardless of workspace.
 * Includes secrets, credentials, VCS internals, and system files.
 */
export const DEFAULT_BLOCKED_PATHS: string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  ".git/",
  "node_modules/",
  ".DS_Store",
];

/**
 * Global blocked home-directory paths — resolved against the user's home.
 */
export const DEFAULT_BLOCKED_HOME_PATHS: string[] = [
  ".ssh/",
  ".aws/",
  ".config/",
];

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp for matching.
 * Supports * (any chars except /), ** (any chars including /), and exact prefixes.
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

/**
 * Check if a path matches any of the glob patterns.
 */
function matchesGlob(filePath: string, globs: string[]): boolean {
  for (const glob of globs) {
    // Handle directory patterns ending with /
    if (glob.endsWith("/")) {
      const dirPattern = glob.slice(0, -1);
      if (filePath.includes(`/`) && filePath.split("/").some((seg) => matchesGlob(seg, [dirPattern]))) {
        return true;
      }
      // Also check if the path starts with the directory
      const dirRegex = globToRegex(glob);
      if (dirRegex.test(filePath)) return true;
    }
    const regex = globToRegex(glob);
    if (regex.test(filePath)) return true;
  }
  return false;
}

/**
 * Resolve a path to its real (symlink-resolved) absolute form.
 * Falls back to absolute path if realpath fails (e.g., file doesn't exist yet).
 */
function resolveRealPath(inputPath: string): { absolutePath: string; realPath: string } {
  const absolutePath = path.resolve(inputPath);
  try {
    const realPath = realpathSync(absolutePath);
    return { absolutePath, realPath };
  } catch {
    // File (or some ancestors) don't exist yet (creation case). Walk up to the
    // deepest existing ancestor, resolve THAT through realpath (so symlinked
    // roots like macOS /var -> /private/var are normalized), then re-append the
    // non-existent tail. This keeps the candidate on the same resolved basis as
    // the workspace root so a new file deep inside the workspace is never
    // wrongly seen as outside it.
    let dir = path.dirname(absolutePath);
    const tail: string[] = [path.basename(absolutePath)];
    while (dir !== path.dirname(dir)) {
      try {
        const dirReal = realpathSync(dir);
        return { absolutePath, realPath: path.join(dirReal, ...tail.reverse()) };
      } catch {
        tail.push(path.basename(dir));
        dir = path.dirname(dir);
      }
    }
    return { absolutePath, realPath: absolutePath };
  }
}

/**
 * Check if a resolved path is inside the workspace root.
 * Both paths are resolved via realpath to handle symlinks (e.g., macOS /var → /private/var).
 */
function isInsideWorkspace(resolvedPath: string, workspaceRoot: string): boolean {
  let normalizedRoot = path.resolve(workspaceRoot);
  // Resolve workspace root via realpath too, to handle macOS /var → /private/var
  try {
    normalizedRoot = realpathSync(normalizedRoot);
  } catch {
    // Workspace root may not exist yet
  }
  const relative = path.relative(normalizedRoot, resolvedPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Self-modification guard (Epic 2 §2.5) — Quiver's own installation/source
 * tree, when known, is write-protected regardless of the configured workspace.
 *
 * When the GUI spawns the agent it resolves its own install root (the
 * directory containing Quiver's package.json) and passes it as the
 * QUIVER_PROTECTED_DIR environment variable. With that variable set, any
 * write/delete that resolves inside the protected tree is refused — even if
 * the user's configured workspace IS the install directory. This is what
 * stops a GUI session from rewriting src/tools/office_doc.ts or the harness
 * itself. CLI/dev usage without the env var is unaffected: developers
 * legitimately edit the repo.
 */
export function getProtectedInstallDir(): string | null {
  const dir = process.env.QUIVER_PROTECTED_DIR;
  if (!dir || !dir.trim()) return null;
  let resolved = path.resolve(dir.trim());
  try {
    resolved = realpathSync(resolved);
  } catch {
    // keep the resolved absolute path
  }
  return resolved;
}

/**
 * Throws if `realPath` is a write/delete target inside the protected
 * install dir (see getProtectedInstallDir). No-op for reads or when the
 * QUIVER_PROTECTED_DIR env var is unset.
 */
export function assertNotProtectedInstallDir(
  realPath: string,
  operation: "read" | "write" | "delete",
): void {
  if (operation === "read") return;
  const protectedDir = getProtectedInstallDir();
  if (!protectedDir) return;
  const rel = path.relative(protectedDir, realPath);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) {
    throw new Error(
      `Path '${realPath}' is inside Quiver's own installation directory ` +
        `('${protectedDir}'), which is write-protected in app sessions. ` +
        `Quiver will not modify its own source or installation. ` +
        `Choose a different workspace folder (Settings → Workspace folder).`,
    );
  }
}

/**
 * Check if a path is inside the user's home directory blocked paths.
 */
function isBlockedHomePath(resolvedPath: string): boolean {
  const home = os.homedir();
  for (const blocked of DEFAULT_BLOCKED_HOME_PATHS) {
    const blockedAbs = path.join(home, blocked);
    if (resolvedPath.startsWith(blockedAbs)) return true;
  }
  return false;
}

// ─── Main API ─────────────────────────────────────────────────────────

/**
 * Resolve and assert that a path is allowed for the given operation.
 *
 * @param inputPath - The user-provided path (may be relative)
 * @param operation - "read" | "write" | "delete"
 * @param policy - The active path policy
 * @returns ResolvedPath with canonical, absolute, and real paths
 * @throws Error if the path is blocked or outside workspace (when not allowed)
 */
export function resolveAndAssertPathAllowed(
  inputPath: string,
  operation: "read" | "write" | "delete",
  policy: PathPolicy,
): ResolvedPath {
  // Security: reject null bytes in paths (CWE-158 — null byte injection)
  if (inputPath.includes("\0")) {
    throw new Error(
      `Path contains null bytes — this is a security violation and is not permitted.`,
    );
  }

  // Expand tilde (~) to home directory so home-dir blocked paths are checked correctly
  let normalizedInput = inputPath;
  if (normalizedInput.startsWith("~")) {
    normalizedInput = path.join(os.homedir(), normalizedInput.slice(1));
  }

  const { absolutePath, realPath } = resolveRealPath(normalizedInput);

  const inside = isInsideWorkspace(realPath, policy.workspaceRoot);

  // Check blocked paths (always blocked, even inside workspace)
  const allBlocked = [...DEFAULT_BLOCKED_PATHS, ...policy.blockedGlobs];

  // Check against the basename and full path
  const basename = path.basename(realPath);
  const relativeToWorkspace = path.relative(policy.workspaceRoot, realPath);

  if (matchesGlob(basename, allBlocked) || matchesGlob(relativeToWorkspace, allBlocked)) {
    throw new Error(
      `Path '${inputPath}' is blocked by security policy (matches blocked glob). ` +
      `This protects sensitive files like .env, credentials, and VCS internals.`,
    );
  }

  // Self-modification guard: GUI-spawned sessions must never write into
  // Quiver's own installation/source tree (QUIVER_PROTECTED_DIR).
  assertNotProtectedInstallDir(realPath, operation);

  // Check home-directory blocked paths
  if (isBlockedHomePath(realPath)) {
    throw new Error(
      `Path '${inputPath}' is blocked — it resolves to a sensitive home directory ` +
      `(.ssh, .aws, .config) which is never accessible.`,
    );
  }

  // ── Workspace boundary + read-scope enforcement (US-6.4) ──
  // Reads are gated by policy.readScope; writes are always confined to the
  // workspace (the tool_paths layer additionally permits ~/.quiver writes and
  // the YOLO sandbox-off bypass).
  if (!inside) {
    if (operation === "read") {
      const scope = policy.readScope ?? "filesystem";
      if (scope === "workspace") {
        throw new Error(
          `Path '${inputPath}' resolves outside the workspace root ` +
            `'${policy.workspaceRoot}'. Read scope is 'workspace' — reads are ` +
            `confined to the project. Raise the trust tier to broaden read scope.`,
        );
      }
      if (scope === "home") {
        const home = os.homedir();
        const relHome = path.relative(home, realPath);
        const insideHome =
          !relHome.startsWith("..") && !path.isAbsolute(relHome);
        if (!insideHome) {
          throw new Error(
            `Path '${inputPath}' resolves outside the workspace and outside the ` +
              `user home directory. Read scope is 'home' — reads are confined to ` +
              `the project + home. Raise the trust tier to broaden read scope.`,
          );
        }
      }
      // "filesystem" → allow (subject to blocked globs + home-blocked paths above)
    } else if (!policy.allowOutsideWorkspace) {
      // write/delete outside workspace without explicit allowance
      throw new Error(
        `Path '${inputPath}' resolves outside the workspace root ` +
          `'${policy.workspaceRoot}'. Set allowOutsideWorkspace=true in ` +
          `PathPolicy to permit this.`,
      );
    }
  }

  // Check operation-specific allow globs (US-6.4: now ENFORCED, not decorative).
  // When a non-empty allow list is set, paths inside the workspace that do NOT
  // match any glob are refused — this is the fine-grained "writes only under
  // src/" granularity. An empty list means "allow all inside the workspace".
  const allowGlobs = operation === "read" ? policy.readAllowGlobs : policy.writeAllowGlobs;
  if (allowGlobs.length > 0 && inside) {
    if (!matchesGlob(relativeToWorkspace, allowGlobs) && !matchesGlob(basename, allowGlobs)) {
      throw new Error(
        `Path '${inputPath}' is outside the ${operation} allow-list for this ` +
        `policy (allowed globs: ${allowGlobs.join(", ")}). ` +
        `Add the path to the allow list or clear it to permit all workspace paths.`,
      );
    }
  }

  return {
    inputPath,
    absolutePath,
    realPath,
    insideWorkspace: inside,
  };
}

/**
 * Create a default PathPolicy for the given workspace root.
 */
export function createDefaultPolicy(workspaceRoot: string): PathPolicy {
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    allowOutsideWorkspace: false,
    readScope: "workspace",
    blockedGlobs: [...DEFAULT_BLOCKED_PATHS],
    readAllowGlobs: [],
    writeAllowGlobs: [],
  };
}

/**
 * Check if a path would be blocked, without throwing.
 * Returns the reason if blocked, null if allowed.
 */
export function checkPathAllowed(
  inputPath: string,
  operation: "read" | "write" | "delete",
  policy: PathPolicy,
): string | null {
  try {
    resolveAndAssertPathAllowed(inputPath, operation, policy);
    return null;
  } catch (e: any) {
    return e.message;
  }
}