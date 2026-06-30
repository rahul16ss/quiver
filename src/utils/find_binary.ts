/**
 * Cross-platform binary discovery utility.
 *
 * Finds the path to a binary on the user's PATH, working across macOS, Linux,
 * and Windows. On macOS/Linux uses `which`, on Windows uses `where`.
 *
 * Used by: ollama_identity.ts, grep_search.ts, and other modules that need
 * to locate system binaries.
 */

import { execFileSync } from "child_process";

/**
 * Find a binary on the user's PATH.
 *
 * @param binaryName - The name of the binary to find (e.g., "rg", "grep", "ollama")
 * @param timeout - Timeout in milliseconds (default 2000)
 * @returns The path to the binary, or null if not found
 */
export function findBinary(
  binaryName: string,
  timeout: number = 2000,
): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const result = execFileSync(cmd, [binaryName], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });
    const found = result.trim().split("\n")[0].trim();
    return found || null;
  } catch {
    return null;
  }
}

/**
 * Check if a binary is available on the user's PATH.
 *
 * @param binaryName - The name of the binary to check
 * @param timeout - Timeout in milliseconds (default 2000)
 * @returns true if the binary is available, false otherwise
 */
export function hasBinary(binaryName: string, timeout: number = 2000): boolean {
  return findBinary(binaryName, timeout) !== null;
}
