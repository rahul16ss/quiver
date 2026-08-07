#!/usr/bin/env node
/**
 * One serial, cwd-independent quality gate for local development and CI.
 *
 * Tools are invoked by their JS entry points with process.execPath — never via
 * npm/npx indirection — so the gate cannot be affected by the caller's cwd or
 * by npx resolution surprises. Every step runs with cwd=PACKAGE_ROOT.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PACKAGE_ROOT, fromPackageRoot } from "./package_root.mjs";

function toolBin(...parts) {
  const entry = fromPackageRoot("node_modules", ...parts);
  if (!existsSync(entry)) {
    console.error(`Missing tool entry: ${entry}. Run npm ci first.`);
    process.exit(1);
  }
  return entry;
}

const steps = [
  ["format", [toolBin("prettier", "bin", "prettier.cjs"), "--check", "."]],
  ["lint", [toolBin("eslint", "bin", "eslint.js"), "."]],
  ["typecheck", [toolBin("typescript", "bin", "tsc"), "--noEmit"]],
  ["build", [fromPackageRoot("scripts", "build.mjs")]],
  ["test", [toolBin("tsx", "dist", "cli.mjs"), "tests/run_tests.ts"]],
  ["daemon-smoke", [toolBin("tsx", "dist", "cli.mjs"), "scripts/daemon_smoke.ts"]],
];

for (const [name, command] of steps) {
  console.log(`\n▶ check:${name}`);
  const result = spawnSync(process.execPath, command, {
    cwd: PACKAGE_ROOT,
    stdio: "inherit",
    env: { ...process.env, QUIVER_PACKAGE_ROOT: PACKAGE_ROOT },
  });
  if (result.error) {
    console.error(`check:${name} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n✖ check:${name} failed with exit ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n✔ Quiver check passed: format, lint, typecheck, build, tests, daemon smoke.");
