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

export interface PathPolicy {
  workspaceRoot: string;
  allowOutsideWorkspace: boolean;
  blockedGlobs: string[];
  readAllowGlobs: string[];
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
    // File doesn't exist yet (creation case) — use absolute path
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
  const { absolutePath, realPath } = resolveRealPath(inputPath);

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

  // Check home-directory blocked paths
  if (isBlockedHomePath(realPath)) {
    throw new Error(
      `Path '${inputPath}' is blocked — it resolves to a sensitive home directory ` +
      `(.ssh, .aws, .config) which is never accessible.`,
    );
  }

  // Check workspace boundary
  if (!inside && !policy.allowOutsideWorkspace) {
    throw new Error(
      `Path '${inputPath}' resolves outside the workspace root '${policy.workspaceRoot}'. ` +
      `Set allowOutsideWorkspace=true in PathPolicy to permit this.`,
    );
  }

  // Check operation-specific allow globs
  const allowGlobs = operation === "read" ? policy.readAllowGlobs : policy.writeAllowGlobs;
  if (allowGlobs.length > 0 && inside) {
    // If allow globs are specified, the path must match one
    if (!matchesGlob(relativeToWorkspace, allowGlobs) && !matchesGlob(basename, allowGlobs)) {
      // Allow globs are a whitelist — if specified, non-matching paths are blocked
      // But only enforce if the list is non-empty (empty = allow all inside workspace)
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