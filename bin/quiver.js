#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Parse arguments
const args = process.argv.slice(2);
const isRecipe = args.includes("--recipe");
const scriptToRun = isRecipe ? "src/goal.ts" : "src/cli.ts";
const scriptPath = path.join(projectRoot, scriptToRun);

// Run the script directly with tsx in the project workspace root
const result = spawnSync("npx", ["tsx", scriptPath, ...args], {
  stdio: "inherit",
  cwd: projectRoot,
});

process.exit(result.status ?? 0);
