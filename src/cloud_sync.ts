/**
 * Cloud sync for Quiver — folder-based, provider-agnostic.
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
 *   5. ~/Library/CloudStorage/  (macOS iCloud / Drive providers)
 *   6. G:\My Drive\             (Windows Google Drive)
 *
 * If no cloud folder is found, Quiver creates a local ~/Quiver/ folder
 * and tells the user to point any cloud sync app at it.
 */

import { promises as fs, existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import { config } from "./config.js";

const QUIVER_FOLDER = "Quiver";

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

  // 2-5. macOS / Linux common locations
  // Note: ~/Library/CloudStorage is a macOS container — check subfolders
  // like ~/Library/CloudStorage/GoogleDrive, ~/Library/CloudStorage/iCloudDrive, etc.
  const candidates = [
    path.join(home, "Google Drive"),
    path.join(home, "GoogleDrive"),
    path.join(home, "OneDrive"),
    path.join(home, "Dropbox"),
    // macOS CloudStorage subfolders (more specific than the container itself)
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
 * If no cloud folder is detected, creates ~/Quiver/ as a local fallback.
 */
export function getQuiverDataDir(): string {
  const cloudFolder = detectCloudFolder();

  if (cloudFolder) {
    return path.join(cloudFolder, QUIVER_FOLDER);
  }

  // No cloud folder — use ~/QuiverData as a local fallback
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

  // Infer provider from folder name
  const name = path.basename(cloudFolder).toLowerCase();
  let provider = "Cloud folder";
  if (name.includes("google")) provider = "Google Drive";
  else if (name.includes("onedrive")) provider = "OneDrive";
  else if (name.includes("dropbox")) provider = "Dropbox";
  else if (name.includes("cloudstorage")) provider = "iCloud / macOS";
  else provider = path.basename(cloudFolder);

  return {
    active: true,
    provider,
    path: path.join(cloudFolder, QUIVER_FOLDER),
  };
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
