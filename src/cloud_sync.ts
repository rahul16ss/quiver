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

import { promises as fs, existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import { config } from "./config.js";

const QUIVER_FOLDER = "Quiver";
const NOTICE_FILE = path.join(os.homedir(), ".quiver_cloud_notice_shown");

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

  const candidates = [
    path.join(home, "Google Drive"),
    path.join(home, "GoogleDrive"),
    path.join(home, "OneDrive"),
    path.join(home, "Dropbox"),
    // macOS CloudStorage subfolders
    path.join(home, "Library", "CloudStorage", "GoogleDrive"),
    path.join(home, "Library", "CloudStorage", "OneDrive"),
    path.join(home, "Library", "CloudStorage", "Dropbox"),
    path.join(home, "Library", "CloudStorage", "iCloudDrive"),
  ];

  // Windows drive letter detection
  if (process.platform === "win32") {
    candidates.push("G:\\My Drive");
    candidates.push("D:\\My Drive");
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
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
    return path.join(cloudFolder, QUIVER_FOLDER);
  }

  return path.join(os.homedir(), "QuiverData");
}

/**
 * Check if a cloud sync folder is detected (for status display).
 */
export function isCloudSyncActive(): boolean {
  return detectCloudFolder() !== null;
}

/**
 * Get cloud sync status for display.
 */
export function getCloudSyncStatus(): {
  active: boolean;
  provider: string;
  path: string;
} {
  const cloudFolder = detectCloudFolder();

  if (!cloudFolder) {
    return {
      active: false,
      provider: "None detected",
      path: path.join(os.homedir(), "QuiverData"),
    };
  }

  const name = path.basename(cloudFolder).toLowerCase();
  let provider = "Cloud folder";
  if (name.includes("google")) provider = "Google Drive";
  else if (name.includes("onedrive")) provider = "OneDrive";
  else if (name.includes("dropbox")) provider = "Dropbox";
  else if (name.includes("icloud")) provider = "iCloud";
  else provider = path.basename(cloudFolder);

  return {
    active: true,
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
 */
export async function ensureCloudDataDir(): Promise<void> {
  const dataDir = getQuiverDataDir();
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, "memory"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "sessions"), { recursive: true });
}

/**
 * Sync memory/ and .sessions/ to the Quiver cloud data folder.
 * Copies local files to the cloud folder (upload) and copies cloud files
 * that don't exist locally back (download for new-machine setup).
 */
export async function syncToCloud(): Promise<{
  uploaded: string[];
  downloaded: string[];
  errors: { file: string; error: string }[];
}> {
  const dataDir = getQuiverDataDir();
  const result = {
    uploaded: [] as string[],
    downloaded: [] as string[],
    errors: [] as { file: string; error: string }[],
  };

  // Ensure the cloud data dir exists
  await fs.mkdir(dataDir, { recursive: true });

  // Directories to sync
  const dirs = [
    { local: path.resolve(config.memoryDir), prefix: "memory" },
    { local: path.resolve(".sessions"), prefix: "sessions" },
  ];

  // Upload: copy local files to cloud
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

    for (const fileName of localFiles) {
      const localPath = path.join(dir.local, fileName);
      const cloudDir = path.join(dataDir, dir.prefix);
      const cloudPath = path.join(cloudDir, fileName);

      try {
        await fs.mkdir(cloudDir, { recursive: true });
        await fs.copyFile(localPath, cloudPath);
        result.uploaded.push(`${dir.prefix}/${fileName}`);
      } catch (err: any) {
        result.errors.push({
          file: `${dir.prefix}/${fileName}`,
          error: err.message,
        });
      }
    }
  }

  // Download: copy cloud files that don't exist locally
  for (const dir of dirs) {
    const cloudDir = path.join(dataDir, dir.prefix);
    let cloudFiles: string[] = [];
    try {
      cloudFiles = await fs.readdir(cloudDir);
    } catch {
      continue;
    }

    for (const fileName of cloudFiles) {
      const cloudPath = path.join(cloudDir, fileName);
      const localPath = path.join(dir.local, fileName);

      if (!existsSync(localPath)) {
        try {
          await fs.mkdir(dir.local, { recursive: true });
          await fs.copyFile(cloudPath, localPath);
          result.downloaded.push(`${dir.prefix}/${fileName}`);
        } catch (err: any) {
          result.errors.push({
            file: `${dir.prefix}/${fileName}`,
            error: err.message,
          });
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
