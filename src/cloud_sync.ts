/**
 * Cloud sync for Quiver — folder-based, provider-agnostic, fully automatic.
 *
 * Quiver writes memory/ and .sessions/ to a local folder that any cloud
 * sync service (Google Drive, OneDrive, Dropbox, iCloud, pCloud, Box,
 * Syncthing, etc.) can sync to the cloud. No OAuth, no API calls, no
 * tokens — just file I/O to a detected or configured path.
 *
 * Auto-detection order:
 *   1. QUIVER_CLOUD_SYNC_PATH env var (explicit override)
 *   2. ~/Google Drive/        (macOS, Windows)
 *   3. ~/OneDrive/             (macOS, Windows)
 *   4. ~/Dropbox/               (macOS, Windows, Linux)
 *   5. ~/Library/CloudStorage/GoogleDrive  (macOS)
 *   6. ~/Library/CloudStorage/OneDrive     (macOS)
 *   7. ~/Library/CloudStorage/Dropbox      (macOS)
 *   8. ~/Library/CloudStorage/iCloudDrive  (macOS)
 *   9. G:\My Drive\             (Windows Google Drive)
 *
 * If no cloud folder is found, Quiver creates ~/QuiverData/ and shows
 * a one-time notice with install links for popular cloud sync apps.
 * The user can also set QUIVER_CLOUD_SYNC_PATH to any synced folder.
 */

import { promises as fs, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import { config } from "./config.js";
import {
  getProjectName,
  getProjectMemoryDir,
  getProjectSessionsDir,
  getGlobalRoot,
} from "./paths.js";

import * as crypto from "crypto";
import { getCredential, setCredential, isKeychainAvailable } from "./secrets/keychain.js";
import { AuditChain } from "./logger.js";

const QUIVER_FOLDER = "Quiver";
const NOTICE_FILE = path.join(os.homedir(), ".quiver_cloud_notice_shown");

/**
 * Opt-in gate (US-4.4): detecting a cloud folder is NEVER consent. Cloud sync
 * stays disabled until the user explicitly enables it. Consent sources:
 *   - QUIVER_CLOUD_SYNC_ENABLED env var ("1" / "true")
 *   - versioned schema config sync.enabled === true (written by the GUI
 *     settings panel / `quiver init`)
 * Default is OFF; the auto-detected folder alone never flips this on.
 */
export function isCloudSyncEnabled(): boolean {
  const env = process.env.QUIVER_CLOUD_SYNC_ENABLED;
  if (env === "1" || env === "true" || env === "on") return true;
  try {
    const file = path.join(getGlobalRoot(), "sync.json");
    if (existsSync(file)) {
      const cfg = JSON.parse(readFileSyncSafe(file));
      if (cfg && cfg.enabled === true) return true;
    }
  } catch {
    // ignore — opt-in is conservative (default off)
  }
  return false;
}

function readFileSyncSafe(p: string): string {
  return readFileSync(p, "utf8");
}

/**
 * Sync is "active" only when the user has opted in AND a sync destination is
 * available. A merely-detected cloud folder never makes sync active.
 */
export function isCloudSyncActive(): boolean {
  return isCloudSyncEnabled() && detectCloudFolder() !== null;
}

/** Install links for popular cloud sync apps. */
export const CLOUD_APP_LINKS: { name: string; url: string }[] = [
  {
    name: "Google Drive for Desktop",
    url: "https://www.google.com/drive/download/",
  },
  {
    name: "OneDrive",
    url: "https://www.microsoft.com/en-us/microsoft-365/onedrive/download",
  },
  { name: "Dropbox", url: "https://www.dropbox.com/install" },
  {
    name: "iCloud (built into macOS)",
    url: "https://support.apple.com/en-us/HT201408",
  },
  { name: "pCloud", url: "https://www.pcloud.com/download.html" },
  {
    name: "Syncthing (self-hosted, free)",
    url: "https://syncthing.net/downloads/",
  },
];

/**
 * Detect the cloud sync folder by checking common locations.
 * Returns the first existing path, or null if none found.
 */
export function detectCloudFolder(): string | null {
  // 1. Explicit override
  if (process.env.QUIVER_CLOUD_SYNC_PATH) {
    const p = path.resolve(process.env.QUIVER_CLOUD_SYNC_PATH);
    if (existsSync(p)) return p;
  }

  const home = os.homedir();

  // Each provider has a root folder, but the actual writable sync folder
  // may be a subfolder (e.g., Google Drive's "My Drive"). We check both
  // the root and known subfolders, preferring the subfolder if it exists.
  const candidates: { path: string; subfolder?: string }[] = [
    // Google Drive: root is read-only on macOS, "My Drive" is writable
    { path: path.join(home, "Google Drive"), subfolder: "My Drive" },
    { path: path.join(home, "GoogleDrive"), subfolder: "My Drive" },
    // macOS CloudStorage Google Drive
    { path: path.join(home, "Library", "CloudStorage", "GoogleDrive"), subfolder: "My Drive" },
    // OneDrive
    { path: path.join(home, "OneDrive") },
    { path: path.join(home, "Library", "CloudStorage", "OneDrive") },
    // Dropbox
    { path: path.join(home, "Dropbox") },
    { path: path.join(home, "Library", "CloudStorage", "Dropbox") },
    // iCloud Drive
    { path: path.join(home, "Library", "CloudStorage", "iCloudDrive") },
  ];

  // Windows drive letter detection
  if (process.platform === "win32") {
    candidates.push({ path: "G:\\My Drive" });
    candidates.push({ path: "D:\\My Drive" });
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;

    // If there's a subfolder, prefer it (it's the writable sync location)
    if (candidate.subfolder) {
      const subfolderPath = path.join(candidate.path, candidate.subfolder);
      if (existsSync(subfolderPath)) {
        return subfolderPath;
      }
    }

    // Fall back to the root if no subfolder or subfolder doesn't exist
    return candidate.path;
  }

  return null;
}

/**
 * Get the Quiver data folder inside the cloud sync folder.
 * If no cloud folder is detected, uses ~/QuiverData as a local fallback.
 */
export function getQuiverDataDir(): string {
  const cloudFolder = detectCloudFolder();

  if (cloudFolder) {
    const cloudQuiverPath = path.join(cloudFolder, QUIVER_FOLDER);
    // Check if we can actually write to the cloud folder
    try {
      mkdirSync(cloudQuiverPath, { recursive: true });
      return cloudQuiverPath;
    } catch {
      // Cloud folder not writable — fall back to local
    }
  }

  const localFallback = path.join(os.homedir(), "QuiverData");
  try {
    mkdirSync(localFallback, { recursive: true });
  } catch {
    // Even local fallback failed — nothing we can do
  }
  return localFallback;
}

/**
 * Check if a cloud sync folder is detected (for status display).
 */
export function getCloudSyncStatus(): {
  active: boolean;
  provider: string;
  path: string;
} {
  // Side-effect-free (US-4.4): a status probe must NEVER create folders on
  // disk. Detection alone is reported; "active" requires explicit opt-in.
  const cloudFolder = detectCloudFolder();

  if (!cloudFolder) {
    return {
      active: false,
      provider: "None detected",
      path: path.join(os.homedir(), "QuiverData"),
    };
  }

  const fullPath = cloudFolder.toLowerCase();
  let provider = "Cloud folder";
  if (fullPath.includes("google")) provider = "Google Drive";
  else if (fullPath.includes("onedrive")) provider = "OneDrive";
  else if (fullPath.includes("dropbox")) provider = "Dropbox";
  else if (fullPath.includes("icloud")) provider = "iCloud";
  else provider = path.basename(cloudFolder);

  return {
    active: isCloudSyncActive(),
    provider,
    path: path.join(cloudFolder, QUIVER_FOLDER),
  };
}

/**
 * Whether the first-run cloud notice has been shown.
 */
function hasShownNotice(): boolean {
  return existsSync(NOTICE_FILE);
}

/**
 * Mark the first-run notice as shown.
 */
async function markNoticeShown(): Promise<void> {
  try {
    await fs.writeFile(NOTICE_FILE, new Date().toISOString(), "utf8");
  } catch {
    // Non-critical
  }
}

/**
 * Show a one-time notice if no cloud folder is detected.
 * Tells the user where their data is and how to enable cloud sync.
 */
export async function maybeShowCloudNotice(): Promise<void> {
  if (detectCloudFolder()) return; // Cloud folder found, no notice needed
  if (hasShownNotice()) return; // Already shown

  const dataDir = getQuiverDataDir();

  console.log("");
  console.log("  \u2601\uFE0F  Cloud sync: No cloud folder detected.");
  console.log(`     Quiver data will be saved locally at: ${dataDir}`);
  console.log(
    "     To sync across machines, install a cloud sync app and Quiver will auto-detect it:",
  );
  for (const app of CLOUD_APP_LINKS) {
    console.log(`       \u2022 ${app.name}: ${app.url}`);
  }
  console.log(
    "     Or set QUIVER_CLOUD_SYNC_PATH in .env to any synced folder.",
  );
  console.log("");

  await markNoticeShown();
}

/**
 * Ensure the Quiver data folder exists (create if needed).
 * Creates the directory structure that syncToCloud expects.
 */
export async function ensureCloudDataDir(): Promise<void> {
  const dataDir = getQuiverDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  // Create the subdirectory structure that syncToCloud uses
  const projectName = getProjectName();
  await fs.mkdir(path.join(dataDir, "global"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "projects", projectName, "memory"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "projects", projectName, "sessions"), { recursive: true });
}

// ─── Sync scope & exclusion policy (US-4.4) ───────────────────────────
// NEVER reach the sync destination:
//   - raw private session logs (the entire .sessions/ tree: *.json,
//     *.state.json, screenshots, tool binaries, raw transcripts)
//   - secrets / credentials (.env, private keys, certificates)
// Inspectable memory files (persona.txt, *.md, project.json, core.json) ARE
// eligible — but only after client-side AES-256-GCM encryption.

const SECRET_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.env$/i,
  /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.git(-credentials|config)?$/i,
  /credential/i,
  /\.(ssh|kdbx)$/i,
];

/**
 * A file is sync-eligible only if it is NOT a secret/credential artifact.
 * (Raw session logs are excluded by never placing the sessions dir in scope.)
 */
export function isSyncEligible(fileName: string): boolean {
  const base = path.basename(fileName);
  if (base.startsWith(".") && base === ".env") return false;
  return !SECRET_FILE_PATTERNS.some((re) => re.test(base));
}

// ─── AES-256-GCM client-side encryption (US-4.4) ──────────────────────
// The sync key is a 256-bit key persisted once at ~/.quiver/sync.key (0600).
// The sync key is a 256-bit key persisted in the OS credential store
// (US-4.4: "passphrase/key stored in the OS credential store"). When the
// keychain is unavailable (headless/CI/locked session), a 0600 on-disk file
// at ~/.quiver/sync.key is used as a restrictive fallback so the pipeline
// never silently disables encryption. The key NEVER leaves the machine —
// only ciphertext is written to the sync folder.

const SYNC_KEYCHAIN_REF = "QUIVER_SYNC_KEY";

async function getSyncKey(): Promise<Buffer> {
  // 1. OS credential store (preferred)
  if (isKeychainAvailable()) {
    const stored = await getCredential(SYNC_KEYCHAIN_REF);
    if (stored) {
      const buf = Buffer.from(stored, "base64");
      if (buf.length === 32) return buf;
    }
    const key = crypto.randomBytes(32);
    await setCredential(SYNC_KEYCHAIN_REF, key.toString("base64"));
    return key;
  }
  // 2. Restrictive on-disk fallback (0600, never synced, never in config.json)
  const keyPath = path.join(getGlobalRoot(), "sync.key");
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    if (raw.length === 32) return Buffer.from(raw);
  }
  const key = crypto.randomBytes(32);
  mkdirSync(getGlobalRoot(), { recursive: true });
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;

/** Encrypt a buffer with AES-256-GCM. Layout: iv(12) || tag(16) || ciphertext. */
export async function encryptBuffer(buf: Buffer): Promise<Buffer> {
  const key = await getSyncKey();
  const iv = crypto.randomBytes(GCM_IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/** Decrypt an AES-256-GCM buffer produced by encryptBuffer. */
export async function decryptBuffer(buf: Buffer): Promise<Buffer> {
  if (buf.length < GCM_IV_LEN + GCM_TAG_LEN) throw new Error("ciphertext too short");
  const key = await getSyncKey();
  const iv = buf.subarray(0, GCM_IV_LEN);
  const tag = buf.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN);
  const enc = buf.subarray(GCM_IV_LEN + GCM_TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// ─── Tamper-evident audit for sync actions (US-9.5 / US-4.4) ────────────
const SYNC_AUDIT_FILE = path.join(getGlobalRoot(), "sync_audit.json");

/** Append a tamper-evident entry to the persistent sync audit chain. */
async function logSyncAudit(action: "sync_conflict" | "sync_cleanup", payload: string): Promise<void> {
  try {
    let chain: AuditChain;
    if (existsSync(SYNC_AUDIT_FILE)) {
      const raw = readFileSync(SYNC_AUDIT_FILE, "utf8");
      chain = AuditChain.deserialize(raw);
    } else {
      chain = new AuditChain();
    }
    chain.appendEntry(action, payload);
    mkdirSync(getGlobalRoot(), { recursive: true });
    writeFileSync(SYNC_AUDIT_FILE, chain.serialize(), "utf8");
  } catch {
    // audit is best-effort — never block sync on it
  }
}

// ─── Consent-gated cleanup of leaked plaintext artifacts (US-4.4 P0) ────
// Pre-fix runs leaked plaintext (raw logs, screenshots, tool binaries,
// credentials, unencrypted memory) to the cloud folder. This NEVER auto-
// deletes — the user's sync target is user-owned data. It enumerates the
// leaked artifacts, shows the list, deletes ONLY after explicit consent,
// and logs every removal to the audit chain.

export interface LeakedArtifact {
  path: string;        // absolute path inside the cloud Quiver folder
  relPath: string;     // path relative to the Quiver folder
  sizeBytes: number;
  reason: string;      // why it is considered a leaked plaintext artifact
}

function classifyLeak(relPath: string): string | null {
  const base = path.basename(relPath);
  // Our own encrypted artifacts are never leaks.
  if (base.endsWith(".enc")) return null;
  // Conflict-preserved copies are intentional, not leaks.
  if (base.includes(".conflict.") || base.includes(".cloud.")) return null;
  if (/^\.env(\..*)?$/i.test(base) || /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(base) || /\.(pem|key|p12|pfx)$/i.test(base))
    return "credential/secret file";
  if (/\.(state\.)?json$/i.test(base)) return "raw session log";
  if (/screenshot/i.test(base) || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(base)) return "screenshot/image";
  if (/\.js$/i.test(base)) return "generated tool binary";
  if (/\.(txt|md|json)$/i.test(base)) return "unencrypted memory/data file";
  return null;
}

/**
 * Enumerate leaked plaintext artifacts in the cloud Quiver folder. Read-only:
 * does not delete anything. Returns the list for the user to review.
 */
export async function enumerateLeakedArtifacts(): Promise<LeakedArtifact[]> {
  const folder = detectCloudFolder();
  if (!folder) return [];
  const quiver = path.join(folder, QUIVER_FOLDER);
  if (!existsSync(quiver)) return [];
  const out: LeakedArtifact[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const rel = path.relative(quiver, full);
        const reason = classifyLeak(rel);
        if (reason) {
          try {
            const st = await fs.stat(full);
            out.push({ path: full, relPath: rel, sizeBytes: st.size, reason });
          } catch { /* skip unreadable */ }
        }
      }
    }
  };
  await walk(quiver);
  return out;
}

/**
 * Consent-gated removal of leaked plaintext artifacts. Deletes ONLY when
 * `confirm` is true (the caller must have already shown the list and obtained
 * explicit y/N consent). Every removal is logged to the tamper-evident audit
 * chain. Never automatic.
 */
export async function cleanupLeakedArtifacts(confirm: boolean): Promise<{
  removed: string[];
  skipped: string[];
}> {
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!confirm) {
    const leaked = await enumerateLeakedArtifacts();
    for (const a of leaked) skipped.push(a.relPath);
    return { removed, skipped };
  }
  const leaked = await enumerateLeakedArtifacts();
  for (const a of leaked) {
    try {
      await fs.unlink(a.path);
      removed.push(a.relPath);
      await logSyncAudit("sync_cleanup", `removed leaked plaintext: ${a.relPath} (${a.reason})`);
    } catch (err: any) {
      skipped.push(a.relPath);
      await logSyncAudit("sync_cleanup", `failed to remove ${a.relPath}: ${err.message}`);
    }
  }
  return { removed, skipped };
}

/** Atomic write: temp file + fsync + rename (US-4.4). */
async function atomicWriteFile(filePath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + ".tmp-" + crypto.randomBytes(4).toString("hex");
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.datasync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Sync inspectable memory to the Quiver cloud data folder.
 *
 * Opt-in gate (US-4.4): a complete no-op (no folder creation, no I/O) while
 * sync is disabled — detection of a cloud folder is never consent.
 *
 * When enabled: uploads eligible memory files (secrets/raw logs excluded)
 * AES-256-GCM encrypted, written atomically; downloads missing files back,
 * decrypting them locally. Plaintext never reaches the destination.
 */
export async function syncToCloud(): Promise<{
  uploaded: string[];
  downloaded: string[];
  errors: { file: string; error: string }[];
  conflicts: string[];
}> {
  const result = {
    uploaded: [] as string[],
    downloaded: [] as string[],
    errors: [] as { file: string; error: string }[],
    conflicts: [] as string[],
  };

  // Opt-in gate: while disabled, sync is a pure no-op (US-4.4).
  if (!isCloudSyncActive()) return result;

  const dataDir = getQuiverDataDir();
  await ensureCloudDataDir();

  const projectName = getProjectName();
  // Scope: global core + per-project memory only. The raw .sessions/ tree
  // (logs, state, screenshots, generated tool binaries) is intentionally
  // excluded from sync — it is private local-only data.
  const dirs: { local: string; prefix: string; filter?: string }[] = [
    { local: getGlobalRoot(), prefix: "global", filter: "core.json" },
    { local: getProjectMemoryDir(), prefix: `projects/${projectName}/memory` },
  ];

  // Upload: encrypt + atomic-write eligible local files
  for (const dir of dirs) {
    let localFiles: string[] = [];
    try {
      const entries = await fs.readdir(dir.local);
      for (const entry of entries) {
        const fullPath = path.join(dir.local, entry);
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) localFiles.push(entry);
      }
    } catch {
      // Local dir doesn't exist yet — skip
    }

    const filesToSync = (dir.filter ? localFiles.filter((f) => f === dir.filter) : localFiles)
      .filter((f) => isSyncEligible(f));

    for (const fileName of filesToSync) {
      const localPath = path.join(dir.local, fileName);
      const cloudDir = path.join(dataDir, dir.prefix);
      const cloudPath = path.join(cloudDir, fileName + ".enc");
      try {
        const plain = await fs.readFile(localPath);
        const localHash = crypto.createHash("sha256").update(plain).digest("hex");
        // Conflict detection (US-4.4): if a cloud artifact already exists and
        // its decrypted content differs from local, both versions diverged.
        // Preserve both (keep-both) and surface the conflict.
        if (existsSync(cloudPath)) {
          try {
            const existingCipher = await fs.readFile(cloudPath);
            const existingPlain = await decryptBuffer(existingCipher);
            const cloudHash = crypto.createHash("sha256").update(existingPlain).digest("hex");
            if (cloudHash !== localHash) {
              const conflictPath = path.join(cloudDir, `${fileName}.conflict.${Date.now()}.enc`);
              await fs.copyFile(cloudPath, conflictPath);
              result.conflicts.push(`${dir.prefix}/${fileName}`);
              await logSyncAudit("sync_conflict", `${dir.prefix}/${fileName}: local and cloud diverged; both versions preserved`);
            }
          } catch {
            // unreadable cloud artifact — treat as fresh upload
          }
        }
        const cipher = await encryptBuffer(plain);
        await atomicWriteFile(cloudPath, cipher);
        result.uploaded.push(`${dir.prefix}/${fileName}`);
      } catch (err: any) {
        result.errors.push({ file: `${dir.prefix}/${fileName}`, error: err.message });
      }
    }
  }

  // Download: decrypt cloud files that don't exist locally
  for (const dir of dirs) {
    const cloudDir = path.join(dataDir, dir.prefix);
    let cloudFiles: string[] = [];
    try {
      cloudFiles = await fs.readdir(cloudDir);
    } catch {
      continue;
    }
    for (const fileName of cloudFiles) {
      // Only consider our encrypted artifacts (skip temp/stray files)
      if (!fileName.endsWith(".enc")) continue;
      const localName = fileName.replace(/\.enc$/, "");
      if (dir.filter && localName !== dir.filter) continue;
      const cloudPath = path.join(cloudDir, fileName);
      const localPath = path.join(dir.local, localName);
      if (existsSync(localPath)) {
        // Both versions exist — detect divergence and preserve both.
        try {
          const localPlain = await fs.readFile(localPath);
          const localHash = crypto.createHash("sha256").update(localPlain).digest("hex");
          const cipher = await fs.readFile(cloudPath);
          const cloudPlain = await decryptBuffer(cipher);
          const cloudHash = crypto.createHash("sha256").update(cloudPlain).digest("hex");
          if (cloudHash !== localHash) {
            const conflictLocal = path.join(dir.local, `${localName}.cloud.${Date.now()}`);
            await fs.writeFile(conflictLocal, cloudPlain);
            result.conflicts.push(`${dir.prefix}/${localName}`);
            await logSyncAudit("sync_conflict", `${dir.prefix}/${localName}: local and cloud diverged on download; cloud copy preserved locally`);
          }
        } catch (err: any) {
          result.errors.push({ file: `${dir.prefix}/${localName}`, error: err.message });
        }
        continue;
      }
      if (!existsSync(localPath)) {
        try {
          const cipher = await fs.readFile(cloudPath);
          const plain = await decryptBuffer(cipher);
          await fs.mkdir(dir.local, { recursive: true });
          await fs.writeFile(localPath, plain);
          result.downloaded.push(`${dir.prefix}/${localName}`);
        } catch (err: any) {
          result.errors.push({ file: `${dir.prefix}/${localName}`, error: err.message });
        }
      }
    }
  }

  return result;
}

/**
 * Auto-sync: silent, debounced. Called after each turn.
 * Waits 5 seconds after the last turn before syncing, so rapid
 * consecutive turns don't trigger multiple syncs.
 */
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_DEBOUNCE_MS = 5000;

export function autoSyncToCloud(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    try {
      await syncToCloud();
    } catch {
      // Silent failure — auto-sync should never interrupt the user
    }
  }, SYNC_DEBOUNCE_MS);
}
