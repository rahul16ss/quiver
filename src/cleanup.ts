/**
 * Residual Leaked Artifacts Cleanup — consent-gated one-time cleanup utility.
 *
 * Scans for residual plaintext artifacts that may have been leaked by the
 * old (pre-fix) cloud sync — plaintext memory files, session logs, or
 * credentials that were synced without encryption. Shows the user exactly
 * what was found and deletes only after explicit consent.
 *
 * Usage: quiver cleanup-leaked
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

// ─── Types ───────────────────────────────────────────────────────────

export interface LeakedArtifact {
  path: string;
  type: "plaintext-memory" | "plaintext-session-log" | "plaintext-credential" | "unencrypted-sync";
  size: number;
  riskLevel: "high" | "medium" | "low";
  description: string;
}

export interface CleanupResult {
  found: LeakedArtifact[];
  deleted: string[];
  skipped: string[];
  consent: boolean;
}

// ─── Scanners ────────────────────────────────────────────────────────

/**
 * Scan for residual leaked artifacts in the cloud sync directory.
 * Looks for files that should have been encrypted but weren't (pre-fix sync).
 */
export async function scanForLeakedArtifacts(
  syncDir?: string,
): Promise<LeakedArtifact[]> {
  const artifacts: LeakedArtifact[] = [];
  const home = os.homedir();

  // 1. Scan cloud sync directory for unencrypted files
  const candidateSyncDirs: string[] = [];
  if (syncDir) {
    candidateSyncDirs.push(syncDir);
  } else {
    // Auto-detect common cloud sync locations
    const candidates = [
      path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "quiver"),
      path.join(home, "Dropbox", "quiver"),
      path.join(home, "OneDrive", "quiver"),
      path.join(home, "Google Drive", "quiver"),
    ];
    for (const c of candidates) {
      try {
        await fs.access(c);
        candidateSyncDirs.push(c);
      } catch {
        // doesn't exist — skip
      }
    }
  }

  for (const dir of candidateSyncDirs) {
    const found = await scanDirectory(dir);
    artifacts.push(...found);
  }

  // 2. Scan for plaintext credentials in project memory dirs
  const projectsDir = path.join(home, ".quiver", "projects");
  try {
    const projects = await fs.readdir(projectsDir);
    for (const proj of projects) {
      const memDir = path.join(projectsDir, proj, "memory");
      try {
        const files = await fs.readdir(memDir);
        for (const f of files) {
          if (f.endsWith(".env") || f.includes("credential") || f.includes("secret")) {
            const fpath = path.join(memDir, f);
            const stat = await fs.stat(fpath);
            artifacts.push({
              path: fpath,
              type: "plaintext-credential",
              size: stat.size,
              riskLevel: "high",
              description: `Plaintext credential file found in project memory: ${f}`,
            });
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // no projects dir
  }

  return artifacts;
}

/**
 * Recursively scan a directory for unencrypted/sensitive files.
 */
async function scanDirectory(dir: string): Promise<LeakedArtifact[]> {
  const artifacts: LeakedArtifact[] = [];

  async function walk(d: string) {
    let entries: string[];
    try {
      entries = await fs.readdir(d);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(d, entry);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await walk(fullPath);
      } else {
        // Check if this is a sensitive file that shouldn't be in sync
        const ext = path.extname(entry).toLowerCase();
        const name = entry.toLowerCase();

        if (name.endsWith(".env") || name.includes("credential") || name.includes("secret")) {
          artifacts.push({
            path: fullPath,
            type: "plaintext-credential",
            size: stat.size,
            riskLevel: "high",
            description: `Plaintext credential file in sync directory: ${entry}`,
          });
        } else if (name.endsWith(".jsonl") || name.endsWith(".log") || name.endsWith(".state.json")) {
          artifacts.push({
            path: fullPath,
            type: "plaintext-session-log",
            size: stat.size,
            riskLevel: "medium",
            description: `Unencrypted session log in sync directory: ${entry}`,
          });
        } else if (ext === ".md" || ext === ".txt") {
          // Check if it's a memory file that was synced without encryption
          const content = await fs.readFile(fullPath, "utf8").catch(() => "");
          if (content.includes("OLLAMA_API_KEY") || content.includes("API_KEY=") || content.includes("GITHUB_TOKEN")) {
            artifacts.push({
              path: fullPath,
              type: "plaintext-memory",
              size: stat.size,
              riskLevel: "high",
              description: `Memory file containing secrets in sync directory: ${entry}`,
            });
          } else {
            artifacts.push({
              path: fullPath,
              type: "unencrypted-sync",
              size: stat.size,
              riskLevel: "low",
              description: `Unencrypted file in sync directory: ${entry}`,
            });
          }
        }
      }
    }
  }

  await walk(dir);
  return artifacts;
}

/**
 * Format leaked artifacts for CLI display.
 */
export function formatLeakedArtifactsForCLI(artifacts: LeakedArtifact[]): string {
  if (artifacts.length === 0) {
    return "✅ No leaked artifacts found. Your sync directory is clean.";
  }

  const lines: string[] = [
    `⚠️  Found ${artifacts.length} potentially leaked artifact(s):`,
    "",
  ];

  for (const a of artifacts) {
    const riskIcon = a.riskLevel === "high" ? "🔴" : a.riskLevel === "medium" ? "🟡" : "🟢";
    lines.push(`  ${riskIcon} [${a.type}] ${a.path}`);
    lines.push(`     ${a.description}`);
    lines.push(`     Size: ${a.size} bytes | Risk: ${a.riskLevel}`);
    lines.push("");
  }

  lines.push("To delete these files, run: quiver cleanup-leaked --confirm");
  return lines.join("\n");
}

/**
 * Delete leaked artifacts after user consent.
 */
export async function deleteLeakedArtifacts(
  artifacts: LeakedArtifact[],
  confirmed: boolean,
): Promise<CleanupResult> {
  const deleted: string[] = [];
  const skipped: string[] = [];

  if (!confirmed) {
    return {
      found: artifacts,
      deleted,
      skipped: artifacts.map((a) => a.path),
      consent: false,
    };
  }

  for (const artifact of artifacts) {
    try {
      await fs.unlink(artifact.path);
      deleted.push(artifact.path);
    } catch {
      skipped.push(artifact.path);
    }
  }

  return {
    found: artifacts,
    deleted,
    skipped,
    consent: true,
  };
}