/**
 * Scratchpad helpers — isolated copy-on-write workspace for the checker.
 *
 * Builds a temp directory with copies of the workspace and node_modules so
 * the checker can run `npx tsx tests/run_tests.ts` without mutating the real
 * workspace's dependencies. A missing dependency is a visible checker
 * infrastructure failure, never an approval.
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
    // The checker will report an infrastructure failure if dependencies are
    // unavailable; it must not convert this into approval.
  }

  return scratchDir;
}