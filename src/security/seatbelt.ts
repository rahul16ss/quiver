/**
 * Seatbelt Sandbox — OS-level filesystem isolation for high-risk operations.
 *
 * Inspired by os-june's use of macOS Seatbelt (sandbox-exec) to confine agent
 * processes to a write-jail. On macOS, we use the `sandbox-exec` command to
 * spawn child processes with a restricted filesystem profile. On Linux/Windows,
 * we fall back to the existing path-policy sandbox (which is already
 * enforced at the tool level).
 *
 * The Seatbelt layer is COMPLEMENTARY to the existing path_policy.ts:
 *   - path_policy.ts: application-level path checks (symlink resolution, blocked globs)
 *   - seatbelt.ts: OS-level process confinement (defense in depth)
 *
 * When a high-risk operation is detected (destructive command, privileged
 * command), the command is executed inside a Seatbelt profile that:
 *   - Allows read access to the workspace and system paths
 *   - Denies writes outside the workspace root
 *   - Denies network access (unless explicitly required)
 *   - Denies access to sensitive home directories (~/.ssh, ~/.aws, etc.)
 *
 * License note: This implementation is original Quiver code (Apache-2.0).
 * The concept of using macOS Seatbelt for agent sandboxing is well-known
 * and not patentable. os-june (MIT) uses a similar approach.
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { config } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────

export type SandboxMode = "sandboxed" | "unrestricted";

export interface SandboxProfile {
  /** Workspace root that the process can read/write. */
  workspaceRoot: string;
  /** Whether network access is allowed. */
  allowNetwork: boolean;
  /** Additional read-only paths outside the workspace. */
  extraReadPaths: string[];
  /** Additional writable paths outside the workspace. */
  extraWritePaths: string[];
}

export interface SandboxResult {
  sandboxed: boolean;
  method: "seatbelt" | "fallback" | "disabled";
  pid?: number;
  profile?: string;
}

// ─── Platform detection ─────────────────────────────────────────────

/**
 * Check if we're on macOS (where Seatbelt/sandbox-exec is available).
 */
export function isSeatbeltAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync("which sandbox-exec", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ─── Seatbelt Profile Generation ─────────────────────────────────────

/**
 * Generate a macOS Seatbelt profile (Sandbox policy language) for the given
 * workspace configuration. The profile:
 *   - Allows process creation, signal handling, and IPC
 *   - Allows reads from system paths (/usr, /bin, /lib, /etc, /tmp, /dev)
 *   - Allows reads from the user's home directory (non-sensitive)
 *   - Allows read-write to the workspace root
 *   - DENIES writes to ~/.ssh, ~/.aws, ~/.config, ~/.gnupg
 *   - Conditionally allows/denies network
 *   - DENIES writes outside the workspace (except extraWritePaths)
 *
 * The profile is written in the macOS Sandbox Profile Language (Scheme-like).
 */
/**
 * Escape a filesystem path for safe interpolation into a double-quoted
 * Sandbox-Profile string. Double-quotes and backslashes are escaped so
 * a project path containing " or \ cannot break out of the write-jail.
 */
function escapeSeatbeltPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function generateSeatbeltProfile(profile: SandboxProfile): string {
  const ws = escapeSeatbeltPath(profile.workspaceRoot);
  const home = escapeSeatbeltPath(os.homedir());

  // Sensitive home paths that are always denied (even reads)
  const sensitivePaths = [
    escapeSeatbeltPath(path.join(os.homedir(), ".ssh")),
    escapeSeatbeltPath(path.join(os.homedir(), ".aws")),
    escapeSeatbeltPath(path.join(os.homedir(), ".config")),
    escapeSeatbeltPath(path.join(os.homedir(), ".gnupg")),
  ];

  // Extra read paths
  const readPaths = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/tmp",
    "/dev",
    "/var/tmp",
    "/System",
    "/Library",
    escapeSeatbeltPath(path.join(os.homedir(), "Library")),
    ...profile.extraReadPaths.map(escapeSeatbeltPath),
  ];

  // Extra write paths (e.g., ~/.quiver for session logs)
  const writePaths = [
    ws,
    escapeSeatbeltPath(path.join(os.homedir(), ".quiver")),
    ...profile.extraWritePaths.map(escapeSeatbeltPath),
  ];

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "",
    ";; ── Allow process operations ──",
    "(allow process-info* (target self))",
    "(allow process-fork)",
    '(allow process-exec (subpath "/usr") (subpath "/bin") (subpath "/sbin"))',
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "",
    ";; ── Allow IPC and mach ──",
    "(allow ipc-posix*)",
    "(allow mach*)",
    "",
    ";; ── Allow reads from system and home paths ──",
  ];

  for (const rp of readPaths) {
    lines.push(`(allow file-read* (subpath "${rp}"))`);
  }

  lines.push("");
  lines.push(";; ── Allow writes to workspace and extra write paths ──");
  for (const wp of writePaths) {
    lines.push(`(allow file-write* (subpath "${wp}"))`);
  }

  lines.push("");
  lines.push(";; ── DENY access to sensitive home directories ──");
  for (const sp of sensitivePaths) {
    lines.push(`(deny file-read* (subpath "${sp}"))`);
    lines.push(`(deny file-write* (subpath "${sp}"))`);
  }

  lines.push("");
  lines.push(";; ── Network ──");
  if (profile.allowNetwork) {
    lines.push("(allow network*)");
  } else {
    lines.push("(deny network*)");
  }

  lines.push("");
  lines.push(";; ── Deny writes outside workspace (catch-all) ──");
  lines.push('(deny file-write* (subpath "/"))');
  // Re-allow workspace writes (deny is last-match in some macOS versions)
  for (const wp of writePaths) {
    lines.push(`(allow file-write* (subpath "${wp}"))`);
  }

  return lines.join("\n");
}

// ─── Sandbox Execution ──────────────────────────────────────────────

/**
 * Write a Seatbelt profile to a temporary file and return its path.
 */
function writeProfileFile(profile: SandboxProfile): string {
  const tmpDir = os.tmpdir();
  const profilePath = path.join(
    tmpDir,
    `quiver-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.sb`,
  );
  const content = generateSeatbeltProfile(profile);
  fs.writeFileSync(profilePath, content, { mode: 0o600 });
  return profilePath;
}

/**
 * Execute a command inside the Seatbelt sandbox on macOS.
 * Falls back to unsandboxed execution on non-macOS platforms.
 *
 * @param command - The shell command to execute
 * @param profile - The sandbox profile configuration
 * @param options - Execution options (cwd, env, etc.)
 * @returns The child process and sandbox result
 */
export function spawnSandboxed(
  command: string,
  profile: SandboxProfile,
  options: { cwd?: string; env?: Record<string, string> } = {},
): { child: ChildProcess; result: SandboxResult } {
  // If sandbox is disabled via YOLO mode, run unsandboxed
  if (config.sandboxDisabled) {
    const child = spawn(command, {
      cwd: options.cwd || profile.workspaceRoot,
      env: options.env || process.env,
      shell: true,
      stdio: "pipe",
    });
    return {
      child,
      result: { sandboxed: false, method: "disabled" },
    };
  }

  // If not on macOS or sandbox-exec not available, fall back
  if (!isSeatbeltAvailable()) {
    const child = spawn(command, {
      cwd: options.cwd || profile.workspaceRoot,
      env: options.env || process.env,
      shell: true,
      stdio: "pipe",
    });
    return {
      child,
      result: { sandboxed: false, method: "fallback" },
    };
  }

  // macOS: use sandbox-exec
  const profilePath = writeProfileFile(profile);
  const sandboxArgs = ["-p", profilePath, command];

  const child = spawn("sandbox-exec", sandboxArgs, {
    cwd: options.cwd || profile.workspaceRoot,
    env: options.env || process.env,
    stdio: "pipe",
    shell: false,
  });

  // Clean up the profile file after the process exits
  child.on("exit", () => {
    try {
      fs.unlinkSync(profilePath);
    } catch {
      // Best-effort cleanup
    }
  });

  return {
    child,
    result: {
      sandboxed: true,
      method: "seatbelt",
      pid: child.pid,
      profile: profilePath,
    },
  };
}

/**
 * Execute a command synchronously inside the Seatbelt sandbox.
 * Returns stdout, stderr, and exit code.
 *
 * @param command - The shell command to execute
 * @param profile - The sandbox profile configuration
 * @param options - Execution options
 */
export function execSandboxed(
  command: string,
  profile: SandboxProfile,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = {},
): { stdout: string; stderr: string; exitCode: number; sandboxed: boolean } {
  // If sandbox is disabled via YOLO mode, run unsandboxed
  if (config.sandboxDisabled) {
    try {
      const stdout = execSync(command, {
        cwd: options.cwd || profile.workspaceRoot,
        env: options.env || process.env,
        timeout: options.timeout || 30000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0, sandboxed: false };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message,
        exitCode: err.status || 1,
        sandboxed: false,
      };
    }
  }

  // If not on macOS or sandbox-exec not available, fall back
  if (!isSeatbeltAvailable()) {
    try {
      const stdout = execSync(command, {
        cwd: options.cwd || profile.workspaceRoot,
        env: options.env || process.env,
        timeout: options.timeout || 30000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { stdout, stderr: "", exitCode: 0, sandboxed: false };
    } catch (err: any) {
      return {
        stdout: err.stdout || "",
        stderr: err.stderr || err.message,
        exitCode: err.status || 1,
        sandboxed: false,
      };
    }
  }

  // macOS: use sandbox-exec synchronously
  const profilePath = writeProfileFile(profile);
  try {
    const fullCmd = `sandbox-exec -p '${profilePath.replace(/'/g, "'\\''")}' ${command}`;
    const stdout = execSync(fullCmd, {
      cwd: options.cwd || profile.workspaceRoot,
      env: options.env || process.env,
      timeout: options.timeout || 30000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0, sandboxed: true };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
      exitCode: err.status || 1,
      sandboxed: true,
    };
  } finally {
    try {
      fs.unlinkSync(profilePath);
    } catch {
      // Best-effort cleanup
    }
  }
}

// ─── Default Profile Factory ────────────────────────────────────────

/**
 * Create a default sandbox profile for the given workspace root.
 * Network is denied by default; the caller can override.
 */
export function createSandboxProfile(
  workspaceRoot: string,
  opts: {
    allowNetwork?: boolean;
    extraReadPaths?: string[];
    extraWritePaths?: string[];
  } = {},
): SandboxProfile {
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    allowNetwork: opts.allowNetwork ?? false,
    extraReadPaths: opts.extraReadPaths ?? [],
    extraWritePaths: opts.extraWritePaths ?? [],
  };
}

/**
 * Check if the Seatbelt sandbox is available and active.
 * Returns a human-readable status string.
 */
export function getSeatbeltStatus(): string {
  if (config.sandboxDisabled) {
    return "disabled (YOLO mode)";
  }
  if (!isSeatbeltAvailable()) {
    return "fallback (path-policy only, no OS sandbox)";
  }
  return "active (macOS Seatbelt)";
}
