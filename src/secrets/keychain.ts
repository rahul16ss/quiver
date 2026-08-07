/**
 * OS Credential Store Integration — US-1.3
 *
 * API keys and credentials are stored in the OS credential store where
 * available (macOS Keychain, Windows Credential Manager, Linux Secret Service).
 * Falls back to .env with restrictive permissions when keychain is unavailable.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import { execFileSync, execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────

export interface CredentialEntry {
  service: string;
  account: string;
  password: string;
}

export type KeychainBackend =
  "macos-keychain" | "windows-credential-manager" | "linux-secret-service" | "none";

// ─── Backend Detection ──────────────────────────────────────────────

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
    execFileSync("security", ["delete-generic-password", "-s", service, "-a", account], {
      stdio: "pipe",
    });
  } catch {
    // Entry doesn't exist yet — fine
  }

  // Add the new entry
  execFileSync(
    "security",
    ["add-generic-password", "-s", service, "-a", account, "-w", password, "-U"],
    { stdio: "pipe" },
  );
}

/**
 * Retrieve a credential from macOS Keychain.
 */
async function macosGet(service: string, account: string): Promise<string | null> {
  try {
    const result = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { stdio: "pipe", encoding: "utf8" },
    );
    return removeCommandTrailingNewline(result);
  } catch {
    return null;
  }
}

/**
 * Delete a credential from macOS Keychain.
 */
async function macosDelete(service: string, account: string): Promise<void> {
  try {
    execFileSync("security", ["delete-generic-password", "-s", service, "-a", account], {
      stdio: "pipe",
    });
  } catch {
    // Entry doesn't exist — fine
  }
}

// ─── Windows Credential Manager ─────────────────────────────────────

function windowsTarget(service: string, account: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(account)) {
    throw new Error("Credential key contains unsupported characters");
  }
  return `${service}:${account}`;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function removeCommandTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

/**
 * Store a credential in Windows Credential Manager using cmdkey.
 *
 * Each Quiver credential gets its own target. Using one target for every
 * account silently overwrote earlier credentials and made keychain hydration
 * unreliable on Windows.
 */
async function windowsSet(service: string, account: string, password: string): Promise<void> {
  const target = windowsTarget(service, account);
  try {
    execFileSync("cmdkey", [`/add:${target}`, `/user:${account}`, `/pass:${password}`], {
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(`Failed to store credential in Windows Credential Manager: ${e}`);
  }
}

/**
 * Retrieve a credential from Windows Credential Manager.
 *
 * `cmdkey /list` intentionally never returns passwords, so this uses the
 * documented CredReadW API through a small, encoded PowerShell bridge. The
 * encoded command avoids shell interpolation of a credential value.
 */
function windowsRead(service: string, account: string): string | null {
  let target: string;
  try {
    target = windowsTarget(service, account);
  } catch {
    return null;
  }
  const psTarget = target.replace(/'/g, "''");
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class QuiverCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool CredFree(IntPtr credential);
}
'@
$ptr = [IntPtr]::Zero
if ([QuiverCredential]::CredRead('${psTarget}', 1, 0, [ref]$ptr)) {
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $ptr, [type][QuiverCredential+CREDENTIAL]
    )
    if ($credential.CredentialBlobSize -gt 0) {
      [Runtime.InteropServices.Marshal]::PtrToStringUni(
        $credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2)
      )
    }
  } finally {
    [QuiverCredential]::CredFree($ptr) | Out-Null
  }
}
`;
  try {
    const result = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
      { stdio: "pipe", encoding: "utf8" },
    );
    const value = removeCommandTrailingNewline(result);
    return value || null;
  } catch {
    return null;
  }
}

async function windowsGet(service: string, account: string): Promise<string | null> {
  return windowsRead(service, account);
}

/** Delete one credential from Windows Credential Manager. */
async function windowsDelete(service: string, account: string): Promise<void> {
  try {
    execFileSync("cmdkey", [`/delete:${windowsTarget(service, account)}`], {
      stdio: "pipe",
    });
  } catch {
    // Entry doesn't exist — fine
  }
}

// ─── Linux Secret Service ───────────────────────────────────────────

/**
 * Store a credential in Linux Secret Service using secret-tool.
 */
async function linuxSet(service: string, account: string, password: string): Promise<void> {
  execFileSync(
    "secret-tool",
    ["store", "--label", service, "service", service, "account", account],
    { input: password, stdio: ["pipe", "pipe", "pipe"] },
  );
}

/**
 * Retrieve a credential from Linux Secret Service.
 */
async function linuxGet(service: string, account: string): Promise<string | null> {
  try {
    const result = execFileSync("secret-tool", ["lookup", "service", service, "account", account], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return removeCommandTrailingNewline(result);
  } catch {
    return null;
  }
}

/**
 * Delete a credential from Linux Secret Service.
 */
async function linuxDelete(service: string, account: string): Promise<void> {
  try {
    execFileSync("secret-tool", ["clear", "service", service, "account", account], {
      stdio: "pipe",
    });
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
        const result = execFileSync(
          "security",
          ["find-generic-password", "-s", SERVICE_NAME, "-a", key, "-w"],
          { stdio: "pipe", encoding: "utf8" },
        );
        return removeCommandTrailingNewline(result);
      }
      case "windows-credential-manager": {
        return windowsRead(SERVICE_NAME, key);
      }
      case "linux-secret-service": {
        const result = execFileSync(
          "secret-tool",
          ["lookup", "service", SERVICE_NAME, "account", key],
          { stdio: "pipe", encoding: "utf8" },
        );
        return removeCommandTrailingNewline(result);
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
 *   1. OS credential store (keychain preferred)
 *   2. process.env[ref] (env / dotenv fallback — already 0600 + gitignored)
 *   3. "" (never read from plaintext config.json)
 */
export function resolveSecretSync(ref: string): string {
  const kc = getCredentialSync(ref);
  return kc || process.env[ref] || "";
}

/** Resolve an engagement-owned connector credential keychain-first. */
export function resolveConnectorSecretSync(connectorName: string): string {
  const normalized = connectorName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "";
  return resolveSecretSync(`QUIVER_CONNECTOR_${normalized}_API_KEY`);
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
      await windowsDelete(SERVICE_NAME, key);
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
export async function migrateEnvToKeychain(
  envPath: string,
): Promise<{ migrated: string[]; failed: string[] }> {
  const migrated: string[] = [];
  const failed: string[] = [];

  if (!fsSync.existsSync(envPath)) {
    return { migrated, failed };
  }

  const content = await fs.readFile(envPath, "utf8");
  const lines = content.split("\n");

  const secretKeys = ["LLM_API_KEY", "PARALLEL_API_KEY"];

  const newLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/);
    if (
      match &&
      (secretKeys.includes(match[1]) || /^QUIVER_CONNECTOR_[A-Z0-9_]+_API_KEY$/.test(match[1]))
    ) {
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
