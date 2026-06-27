#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

const result = spawnSync("npx", ["tsx", path.join(projectRoot, "src", "cli.ts"), ...args], {
  stdio: "inherit",
  cwd: projectRoot,
});

process.exit(result.status ?? 0);