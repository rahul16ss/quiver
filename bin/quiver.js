#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

// The daemon/experience-plane subcommands route to the launcher (Phase 8, ADR-009):
//   quiver harness | start | status | open | diagnostics | register-workspace
// Everything else (chat, --single-turn --json, init, etc.) routes to the CLI.
const launcherSubs = new Set([
  "harness",
  "start",
  "status",
  "open",
  "diagnostics",
  "register-workspace",
]);
const isLauncher = launcherSubs.has(args[0]);
const target = isLauncher
  ? path.join(projectRoot, "src", "harness", "launcher.ts")
  : path.join(projectRoot, "src", "cli.ts");

// Resolve the tsx loader path from the project's node_modules so we don't
// depend on npx (which adds an extra process layer that can interfere with
// stdin passthrough in interactive REPL mode).
const tsxEntry = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

if (existsSync(tsxEntry)) {
  const result = spawnSync(process.execPath, ["--import", "tsx", target, ...args], {
    stdio: "inherit",
    cwd: projectRoot,
  });
  process.exit(result.status ?? 0);
} else {
  const result = spawnSync("npx", ["tsx", target, ...args], {
    stdio: "inherit",
    cwd: projectRoot,
  });
  process.exit(result.status ?? 0);
}