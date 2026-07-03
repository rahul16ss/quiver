#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

// Resolve the tsx loader path from the project's node_modules so we don't
// depend on npx (which adds an extra process layer that can interfere with
// stdin passthrough in interactive REPL mode — the root cause of
// "zsh: parse error near `do'" when quiver exits and leaves the user's
// typed input in the terminal buffer for the parent shell to interpret).
const tsxEntry = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

if (existsSync(tsxEntry)) {
  // node --import tsx: registers the TypeScript loader and runs cli.ts
  // directly in this process — no npx, no extra pipe, stdin stays clean.
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(projectRoot, "src", "cli.ts"), ...args],
    {
      stdio: "inherit",
      cwd: projectRoot,
    },
  );
  process.exit(result.status ?? 0);
} else {
  // Fallback: npx tsx (for environments where node_modules isn't available,
  // e.g. a globally installed quiver without a local node_modules)
  const result = spawnSync(
    "npx",
    ["tsx", path.join(projectRoot, "src", "cli.ts"), ...args],
    {
      stdio: "inherit",
      cwd: projectRoot,
    },
  );
  process.exit(result.status ?? 0);
}
