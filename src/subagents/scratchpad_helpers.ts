/**
 * Scratchpad helpers — shared between Phase 1 checker and Phase 2 adversarial loop.
 *
 * Builds an isolated copy-on-write scratchpad directory so the checker/checker
 * agent never runs against the real workspace cwd and can never mutate the
 * user's project (US-15.2/15.3, per US-5.3).
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

/**
 * Build an isolated copy-on-write scratchpad directory.
 * Copies src/, tests/, ui/ and config files. Does not link external packages.
 *
 * @param workspaceRoot - The real workspace root to copy from
 * @returns The scratchpad directory path
 */
export async function buildScratchpad(workspaceRoot: string): Promise<string> {
  const scratchDir = path.join(
    os.tmpdir(),
    `quiver-scratch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(scratchDir, { recursive: true });

  // Copy source, test, and ui directories (read-only inspection)
  for (const dir of ["src", "tests", "ui", "docs", "Formula", "branding", "bin", "skills", "templates"]) {
    try {
      await fs.cp(
        path.join(workspaceRoot, dir),
        path.join(scratchDir, dir),
        { recursive: true },
      );
    } catch {
      /* best-effort copy */
    }
  }

  // Copy config files needed for tsc / tsx
  for (const file of ["package.json", "tsconfig.json"]) {
    try {
      await fs.copyFile(
        path.join(workspaceRoot, file),
        path.join(scratchDir, file),
      );
    } catch {
      /* best-effort */
    }
  }

  // Do NOT link the real project's node_modules into the scratchpad.
  // A subagent or checker process could write to node_modules/<pkg>/index.js
  // and mutate the real project's dependencies, breaking the "cannot write to
  // the real workspace" guarantee (US-5.3). The checker uses `npx tsx` which
  // resolves tsx from the global npx cache, not from the workspace.

  return scratchDir;
}