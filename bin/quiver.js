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
// stdin passthrough in interactive REPL mode).
const tsxEntry = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

if (existsSync(tsxEntry)) {
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