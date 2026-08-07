#!/usr/bin/env node

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

// The daemon/experience-plane subcommands route to the launcher:
//   quiver harness | start | status | open | diagnostics | register-workspace
// Everything else routes to the CLI. Prefer the compiled dist/ runtime so a
// packaged install does not depend on tsx or TypeScript sources. The source
// fallback keeps a bare git checkout usable after `npm ci`.
const launcherSubs = new Set([
  "harness",
  "start",
  "status",
  "open",
  "diagnostics",
  "register-workspace",
]);
const isLauncher = launcherSubs.has(args[0]);
const compiledTarget = path.join(
  projectRoot,
  "dist",
  isLauncher ? path.join("harness", "launcher.js") : "cli.js",
);
const sourceTarget = path.join(
  projectRoot,
  "src",
  isLauncher ? path.join("harness", "launcher.ts") : "cli.ts",
);

let command;
let commandArgs;
let cwd = projectRoot;

if (existsSync(compiledTarget)) {
  command = process.execPath;
  commandArgs = [compiledTarget, ...args];
} else if (existsSync(sourceTarget)) {
  // Resolve the repository-local tsx loader first; it is a devDependency and
  // intentionally not required by the compiled production path.
  const tsxEntry = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(tsxEntry)) {
    command = process.execPath;
    commandArgs = ["--import", "tsx", sourceTarget, ...args];
  } else {
    command = "npx";
    commandArgs = ["--no-install", "tsx", sourceTarget, ...args];
  }
} else {
  console.error(
    "Quiver runtime is missing. Run `npm run build` in a source checkout, " +
      "or install a package built with its prepack step.",
  );
  process.exit(1);
}

const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  cwd,
  env: { ...process.env, QUIVER_PACKAGE_ROOT: projectRoot },
});
process.exit(result.status ?? 0);
