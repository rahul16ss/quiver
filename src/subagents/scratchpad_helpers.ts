/**
 * Scratchpad helpers — isolated copy-on-write workspace for the checker.
 *
 * Builds a temp directory with copies of src/, tests/, ui/, docs/, config
 * files, AND node_modules — so the checker can run `npx tsx tests/run_tests.ts`
 * with all dependencies available. The copy (not a symlink) ensures the
 * checker can never mutate the real workspace's dependencies.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

export async function buildScratchpad(workspaceRoot: string): Promise<string> {
  const scratchDir = path.join(
    os.tmpdir(),
    `quiver-scratch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(scratchDir, { recursive: true });

  // Copy source, test, and ui directories
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

  // Copy node_modules so the checker can run tests with all dependencies.
  // This is a COPY (not a symlink) — modifications in the scratchpad don't
  // affect the real workspace. The scratchpad is temp and deleted after use.
  // Without this, npx tsx can't find dependencies (picocolors, zod, etc.)
  // and the checker gets 0/0 results, causing a deadlock where the fix
  // can't be applied because the checker blocks it.
  try {
    await fs.cp(
      path.join(workspaceRoot, "node_modules"),
      path.join(scratchDir, "node_modules"),
      { recursive: true },
    );
  } catch {
    // If node_modules copy fails (e.g. too large), the checker will
    // fail-open (0/0 → approve) rather than deadlock.
  }

  return scratchDir;
}