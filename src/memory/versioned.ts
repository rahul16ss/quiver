/**
 * Versioned Memory — US-17.19 / Epic 6.
 *
 * Memory files (persona.txt, human.txt, audit-findings.md, etc.) are
 * versioned. Every write creates a snapshot in `.quiver/memory-versions/`.
 * The user can diff versions, roll back, and see the history of what
 * the AI's memory looked like at any point.
 *
 * This is the "versioned · visible · editable · consented" requirement
 * from SPEC §6.1 layer B.
 *
 * Architecture:
 * - Snapshots are stored as `{filename}.{version}.bak` in the memory versions directory
 * - A `versions.json` index tracks version metadata (timestamp, reason, hash)
 * - `memory_append` and `memory_replace` automatically create snapshots before writing
 * - `/memory-history <filename>` shows the version history
 * - `/memory-rollback <filename> <version>` restores a previous version
 * - `/memory-diff <filename> <v1> <v2>` shows the diff between two versions
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getProjectMemoryDir } from "../paths.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface MemoryVersion {
  version: number;
  filename: string;
  timestamp: string;
  hash: string;
  size: number;
  reason: string;
}

export interface VersionIndex {
  [filename: string]: MemoryVersion[];
}

// ─── Paths ────────────────────────────────────────────────────────────

function getVersionsDir(): string {
  return path.join(getProjectMemoryDir(), "versions");
}

function getVersionsIndexPath(): string {
  return path.join(getVersionsDir(), "versions.json");
}

function getSnapshotPath(filename: string, version: number): string {
  return path.join(getVersionsDir(), `${filename}.${version}.bak`);
}

// ─── Core functions ──────────────────────────────────────────────────

/**
 * Load the version index from disk.
 */
export async function loadVersionIndex(): Promise<VersionIndex> {
  try {
    const raw = await fs.readFile(getVersionsIndexPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Save the version index to disk.
 */
async function saveVersionIndex(index: VersionIndex): Promise<void> {
  const dir = getVersionsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getVersionsIndexPath(), JSON.stringify(index, null, 2), "utf8");
}

/**
 * Create a snapshot of a memory file before it's modified.
 * Returns the version number of the new snapshot, or null if the file doesn't exist.
 */
export async function createSnapshot(
  filename: string,
  reason: string = "pre-write",
): Promise<MemoryVersion | null> {
  const memoryDir = getProjectMemoryDir();
  const filePath = path.join(memoryDir, path.basename(filename));

  // Check if file exists
  try {
    await fs.access(filePath);
  } catch {
    return null; // File doesn't exist yet — no snapshot needed
  }

  const content = await fs.readFile(filePath, "utf8");
  const hash = crypto.createHash("sha256").update(content).digest("hex").substring(0, 16);
  const size = Buffer.byteLength(content, "utf8");

  // Load index and get next version number
  const index = await loadVersionIndex();
  const versions = index[filename] || [];
  const version = versions.length > 0 ? versions[versions.length - 1].version + 1 : 1;

  // Check if content is identical to the last snapshot
  if (versions.length > 0 && versions[versions.length - 1].hash === hash) {
    return versions[versions.length - 1]; // No change — don't create duplicate
  }

  // Write snapshot
  const dir = getVersionsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getSnapshotPath(filename, version), content, "utf8");

  // Update index
  const entry: MemoryVersion = {
    version,
    filename,
    timestamp: new Date().toISOString(),
    hash,
    size,
    reason,
  };
  versions.push(entry);
  index[filename] = versions;
  await saveVersionIndex(index);

  return entry;
}

/**
 * Get the version history for a memory file.
 */
export async function getHistory(filename: string): Promise<MemoryVersion[]> {
  const index = await loadVersionIndex();
  return index[filename] || [];
}

/**
 * Roll back to a specific version of a memory file.
 */
export async function rollbackToVersion(
  filename: string,
  version: number,
): Promise<{ success: boolean; message: string }> {
  const memoryDir = getProjectMemoryDir();
  const filePath = path.join(memoryDir, path.basename(filename));
  const snapshotPath = getSnapshotPath(filename, version);

  try {
    const content = await fs.readFile(snapshotPath, "utf8");

    // Create a snapshot of the current state before rolling back
    await createSnapshot(filename, "pre-rollback");

    // Restore the old content
    await fs.writeFile(filePath, content, "utf8");

    return {
      success: true,
      message: `Rolled back ${filename} to version ${version}`,
    };
  } catch {
    return {
      success: false,
      message: `Version ${version} of ${filename} not found`,
    };
  }
}

/**
 * Get the content of a specific version.
 */
export async function getVersionContent(
  filename: string,
  version: number,
): Promise<string | null> {
  try {
    return await fs.readFile(getSnapshotPath(filename, version), "utf8");
  } catch {
    return null;
  }
}

/**
 * Generate a simple line-by-line diff between two versions.
 */
export async function diffVersions(
  filename: string,
  version1: number,
  version2: number,
): Promise<string> {
  const content1 = await getVersionContent(filename, version1);
  const content2 = await getVersionContent(filename, version2);

  if (content1 === null) return `Version ${version1} not found.`;
  if (content2 === null) return `Version ${version2} not found.`;

  const lines1 = content1.split("\n");
  const lines2 = content2.split("\n");
  const maxLen = Math.max(lines1.length, lines2.length);

  const diffLines: string[] = [];
  diffLines.push(`Diff: ${filename} v${version1} → v${version2}`);
  diffLines.push("─".repeat(60));

  for (let i = 0; i < maxLen; i++) {
    const l1 = lines1[i] ?? "";
    const l2 = lines2[i] ?? "";
    if (l1 === l2) {
      diffLines.push(`  ${l1}`);
    } else {
      if (l1) diffLines.push(`- ${l1}`);
      if (l2) diffLines.push(`+ ${l2}`);
    }
  }

  return diffLines.join("\n");
}

/**
 * Format the version history for CLI display.
 */
export async function formatHistoryForCLI(filename: string): Promise<string> {
  const history = await getHistory(filename);
  if (history.length === 0) {
    return `No version history for ${filename}`;
  }

  const lines: string[] = [];
  lines.push(`Version history for ${filename}:`);
  lines.push("─".repeat(60));
  for (const v of history) {
    lines.push(
      `  v${v.version} · ${v.timestamp} · ${v.size}b · ${v.reason}`,
    );
  }
  lines.push("");
  lines.push(`Use /memory-rollback ${filename} <version> to restore a version`);
  lines.push(`Use /memory-diff ${filename} <v1> <v2> to compare versions`);

  return lines.join("\n");
}