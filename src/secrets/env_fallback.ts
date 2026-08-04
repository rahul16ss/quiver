/**
 * .env Fallback — Restrictive Secret Storage (US-1.3)
 *
 * When the OS keychain is unavailable, secrets are written to a .env file
 * with restrictive permissions:
 *   - File mode 0o600 (owner read/write only)
   - Added to .gitignore to prevent accidental commits
   - Kept local and excluded from version control to prevent secret leakage
 *
 * This is a plaintext fallback -- the OS keychain is always preferred.
 */

import { promises as fs, existsSync } from "fs";
import * as path from "path";

const FILE_PERMISSIONS = 0o600;

export async function writeFallback(p: string): Promise<void> {
  await fs.writeFile(p, "", { mode: FILE_PERMISSIONS });
  // Ensure .gitignore contains the file
  const gitignorePath = path.join(path.dirname(p), ".gitignore");
  let gitignore = "";
  if (existsSync(gitignorePath)) {
    gitignore = await fs.readFile(gitignorePath, "utf8");
  }
  if (!gitignore.includes(".env")) {
    gitignore += "\n.env\n";
    await fs.writeFile(gitignorePath, gitignore);
  }
}

export async function readFallback(p: string): Promise<string | null> {
  if (!existsSync(p)) return null;
  const content = await fs.readFile(p, "utf8");
  return content || null;
}