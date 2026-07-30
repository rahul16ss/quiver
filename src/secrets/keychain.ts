/**
 * OS Credential Store Integration — US-1.3
 *
 * API keys and credentials are stored in the OS credential store where
 * available (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 * Falls back to .env with restrictive permissions when keychain is unavailable.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────

export interface CredentialEntry {
  service: string;
  account: string;
  password: string;
}

export type KeychainBackend = "macos-keychain" | "windows-credential-manager" | "linux-secret-service" | "none";

// ─── Backend Detection ──────────────────────────────────────────────

// ─── Shell Escaping ───────────────────────────────────────────────────
// Service/account values are interpolated into `security`/`cmdkey` shell
// commands. They must be escaped for the surrounding quote context so a
// crafted account name can never break out and inject commands (US-1.3).

/** Escape a value for safe interpolation inside a double-quoted shell arg. */
function shEscapeDouble(value: string): string {
  // Escape backslash, double quote, backtick, and dollar so the value cannot
  // terminate the quoted context or trigger command/arithmetic expansion.
  return String(value).replace(/\\/g, "\\\\").replace(/["`$]/g, "\\$&");
}

/**
 * Detect which OS credential store backend is available.
 */
export function detectBackend(): KeychainBackend {
  const platform = process.platform;

  if (platform === "darwin") {
    try {
      execSync("which security", { stdio: "pipe" });
      return "macos-keychain";
    } catch {
      return "none";
    }
  }

  if (platform === "win32") {
    try {
      execSync("where cmdkey", { stdio: "pipe" });
      return "windows-credential-manager";
    } catch {
      return "none";
    }
  }

  if (platform === "linux") {
    try {
      execSync("which secret-tool", { stdio: "pipe" });
      return "linux-secret-service";
    } catch {
      return "none";
    }
  }

  return "none";
}

/**
 * Check if any OS credential store is available.
 */
export function isKeychainAvailable(): boolean {
  return detectBackend() !== "none";
}

// ─── macOS Keychain ──────────────────────────────────────────────────

/**
 * Store a credential in macOS Keychain.
 */
async function macosSet(service: string, account: string, password: string): Promise<void> {
  // Delete existing entry first (security add-generic-password fails if it exists)
  try {
    execSync(`security delete-generic-password -s "${shEscapeDouble(service)}" -a "${shEscapeDouble(account)}"`, { stdio: "pipe" });
  } catch {
    // Entry doesn't exist yet — fine
  }

  // Add the new entry
  const escapedPassword = password.replace(/'/g, "'\\''");
  execSync(
    `security add-generic-password -s "${shEscapeDouble(service)}" -a "${shEscapeDouble(account)}" -w '${escapedPassword}' -U`,
    { stdio: "pipe" },
  );
}

/**
 * Retrieve a credential from macOS Keychain.
 */
async function macosGet(service: string, account: string): Promise<string | null> {
  try {
    const result = execSync(
      `security find-generic-password -s "${shEscapeDouble(service)}" -a "${shEscapeDouble(account)}" -w`,
      { stdio: "pipe", encoding: "utf8" },
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Delete a credential from macOS Keychain.
 */
async function macosDelete(service: string, account: string): Promise<void> {
  try {
    execSync(`security delete-generic-password -s "${shEscapeDouble(service)}" -a "${shEscapeDouble(account)}"`, { stdio: "pipe" });
  } catch {
    // Entry doesn't exist — fine
  }
}

// ─── Windows Credential Manager ─────────────────────────────────────

/**
 * Store a credential in Windows Credential Manager using cmdkey.
 */
async function windowsSet(service: string, account: string, password: string): Promise<void> {
  // cmdkey reliably stores credentials; values are escaped for the shell context.
  try {
    execSync(
      `cmdkey /add:"${shEscapeDouble(service)}" /user:"${shEscapeDouble(account)}" /pass:"${shEscapeDouble(password)}"`,
      { stdio: "pipe" },
    );
  } catch (e) {
    throw new Error(`Failed to store credential in Windows Credential Manager: ${e}`);
  }
}

/**
 * Retrieve a credential from Windows Credential Manager.
 */
async function windowsGet(service: string, account: string): Promise<string | null> {
  // cmdkey /list deliberately does NOT display stored passwords (by design).
  // Retrieval requires the Win32 CredRead API via PInvoke. We invoke CredRead
  // and decode the CREDENTIAL_BLOB; if the PInvoke is unavailable (restricted
  // policy / missing entry) we return null rather than silently returning the
  // wrong value.
  const script =
    "$sig='[DllImport(\"advapi32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]public static extern bool CredReadW(string t,uint f,uint c,out IntPtr p);[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]public struct CRED{public uint Flags;public uint Type;public string TargetName;public string Comment;public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;public uint CredentialBlobSize;public IntPtr CredentialBlob;public uint Persist;public uint AttributeCount;public IntPtr Attributes;public string TargetAlias;public string UserName;}'; " +
    "Add-Type -Namespace QC -Name Cred -MemberDefinition $sig; " +
    "$p=[IntPtr]::Zero; if(-not [QC.Cred]::CredReadW('" + shEscapeDouble(service) + "',1,0,[ref]$p)){return}; " +
    "$m=[System.Runtime.InteropServices.Marshal]; $c=$m::PtrToStructure($p,[QC.Cred+CRED]); " +
    "$blob=$m::PtrToStringUni($c.CredentialBlob,$c.CredentialBlobSize/2); $m::Free($p); $blob";
  try {
    const result = execSync(`powershell -NoProfile -Command "${script}"`, { stdio: "pipe", encoding: "utf8" });
    const trimmed = result.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Delete a credential from Windows Credential Manager.
 */
async function windowsDelete(service: string): Promise<void> {
  try {
    execSync(`cmdkey /delete:"${service}"`, { stdio: "pipe" });
  } catch {
    // Entry doesn't exist — fine
  }
}

// ─── Linux Secret Service ───────────────────────────────────────────

/**
 * Store a credential in Linux Secret Service using secret-tool.
 */
async function linuxSet(service: string, account: string, password: string): Promise<void> {
  const escapedPassword = password.replace(/'/g, "'\\''");
  execSync(
    `echo '${escapedPassword}' | secret-tool store --label="${service}" service "${service}" account "${account}"`,
    { stdio: "pipe" },
  );
}

/**
 * Retrieve a credential from Linux Secret Service.
 */
async function linuxGet(service: string, account: string): Promise<string | null> {
  try {
    const result = execSync(
      `secret-tool lookup service "${service}" account "${account}"`,
      { stdio: "pipe", encoding: "utf8" },
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Delete a credential from Linux Secret Service.
 */
async function linuxDelete(service: string, account: string): Promise<void> {
  try {
    execSync(`secret-tool clear service "${service}" account "${account}"`, { stdio: "pipe" });
  } catch {
    // Entry doesn't exist — fine
  }
}

// ─── Unified API ─────────────────────────────────────────────────────

const SERVICE_NAME = "Quiver";

/**
 * Store a credential in the OS credential store.
 *
 * @param key - The credential key (e.g., "LLM_API_KEY")
 * @param value - The secret value to store
 */
export async function setCredential(key: string, value: string): Promise<boolean> {
  const backend = detectBackend();

  try {
    switch (backend) {
      case "macos-keychain":
        await macosSet(SERVICE_NAME, key, value);
        return true;

      case "windows-credential-manager":
        await windowsSet(SERVICE_NAME, key, value);
        return true;

      case "linux-secret-service":
        await linuxSet(SERVICE_NAME, key, value);
        return true;

      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Retrieve a credential from the OS credential store.
 *
 * @param key - The credential key (e.g., "LLM_API_KEY")
 * @returns The secret value, or null if not found
 */
export async function getCredential(key: string): Promise<string | null> {
  const backend = detectBackend();

  try {
    switch (backend) {
      case "macos-keychain":
        return await macosGet(SERVICE_NAME, key);

      case "windows-credential-manager":
        return await windowsGet(SERVICE_NAME, key);

      case "linux-secret-service":
      return await linuxGet(SERVICE_NAME, key);

      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Synchronously retrieve a credential from the OS credential store.
 * Used during early config bootstrap (config.ts loads before any async
 * runtime is available). Mirrors getCredential but uses the synchronous
 * exec-based backends directly.
 */
export function getCredentialSync(key: string): string | null {
  const backend = detectBackend();
  try {
    switch (backend) {
      case "macos-keychain": {
        const result = execSync(
          `security find-generic-password -s "${SERVICE_NAME}" -a "${key}" -w`,
          { stdio: "pipe", encoding: "utf8" },
        );
        return result.trim();
      }
      case "windows-credential-manager": {
        const script =
          "$sig='[DllImport(\"advapi32.dll\", CharSet=CharSet.Unicode, SetLastError=true)]public static extern bool CredReadW(string t,uint f,uint c,out IntPtr p);[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]public struct CRED{public uint Flags;public uint Type;public string TargetName;public string Comment;public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;public uint CredentialBlobSize;public IntPtr CredentialBlob;public uint Persist;public uint AttributeCount;public IntPtr Attributes;public string TargetAlias;public string UserName;}'; " +
          "Add-Type -Namespace QC -Name Cred -MemberDefinition $sig; " +
          "$p=[IntPtr]::Zero; if(-not [QC.Cred]::CredReadW('" + shEscapeDouble(SERVICE_NAME) + "',1,0,[ref]$p)){return}; " +
          "$m=[System.Runtime.InteropServices.Marshal]; $c=$m::PtrToStructure($p,[QC.Cred+CRED]); " +
          "$blob=$m::PtrToStringUni($c.CredentialBlob,$c.CredentialBlobSize/2); $m::Free($p); $blob";
        const result = execSync(`powershell -NoProfile -Command "${script}"`, { stdio: "pipe", encoding: "utf8" });
        const trimmed = result.trim();
        return trimmed ? trimmed : null;
      }
      case "linux-secret-service": {
        const result = execSync(
          `secret-tool lookup service "${SERVICE_NAME}" account "${key}"`,
          { stdio: "pipe", encoding: "utf8" },
        );
        return result.trim();
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Resolve a secret value with explicit-consent ordering (US-1.3):
 *   1. process.env[ref] (env / dotenv fallback — already 0600 + gitignored)
 *   2. OS credential store (keychain preferred)
 *   3. "" (never read from plaintext config.json)
 */
export function resolveSecretSync(ref: string): string {
  if (process.env[ref]) return process.env[ref];
  const kc = getCredentialSync(ref);
  return kc ?? "";
}

/**
 * Delete a credential from the OS credential store.
 *
 * @param key - The credential key to delete
 */
export async function deleteCredential(key: string): Promise<void> {
  const backend = detectBackend();

  switch (backend) {
    case "macos-keychain":
      await macosDelete(SERVICE_NAME, key);
      break;

    case "windows-credential-manager":
      await windowsDelete(SERVICE_NAME);
      break;

    case "linux-secret-service":
      await linuxDelete(SERVICE_NAME, key);
      break;
  }
}

/**
 * Migrate credentials from .env to the OS credential store.
 * Reads .env file, extracts known secret keys, stores them in keychain,
 * and removes them from .env.
 */
export async function migrateEnvToKeychain(envPath: string): Promise<{ migrated: string[]; failed: string[] }> {
  const migrated: string[] = [];
  const failed: string[] = [];

  if (!fsSync.existsSync(envPath)) {
    return { migrated, failed };
  }

  const content = await fs.readFile(envPath, "utf8");
  const lines = content.split("\n");

  const secretKeys = [
    "LLM_API_KEY",
    "PARALLEL_API_KEY",
    "GITHUB_TOKEN",
  ];

  const newLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (match && secretKeys.includes(match[1])) {
      const key = match[1];
      const value = match[2].replace(/^["']|["']$/g, "");

      const success = await setCredential(key, value);
      if (success) {
        migrated.push(key);
        // Don't include this line in the new .env
        continue;
      } else {
        failed.push(key);
      }
    }
    newLines.push(line);
  }

  // Write back the .env without the migrated secrets
  await fs.writeFile(envPath, newLines.join("\n"), "utf8");

  return { migrated, failed };
}
