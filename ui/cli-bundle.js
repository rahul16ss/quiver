#!/usr/bin/env node
/**
 * Bundled CLI entry point for the Electron app.
 * This file is packaged inside the .app and spawns the CLI using
 * the bundled Node.js (Electron's) instead of requiring npx/tsx.
 *
 * It registers tsx's loader so TypeScript files run directly,
 * then imports the CLI entry point.
 */
const path = require("path");
const { spawn } = require("child_process");

// In a packaged app, resources are in the app bundle
const isPackaged = process.env.ELECTRON_PACKAGED === "1";
const appRoot = isPackaged
  ? path.resolve(process.env.APP_ROOT || path.dirname(process.execPath), "..", "Resources")
  : path.resolve(__dirname, "..");

// Register tsx loader for TypeScript support
try {
  require("tsx/cjs");
} catch (e) {
  // tsx not available — try direct node with --import
  console.error("tsx loader not available, trying direct execution...");
}

// Spawn the CLI with the tsx loader
const cliPath = path.join(appRoot, "src", "cli.ts");
const args = process.argv.slice(2);

const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
  stdio: "inherit",
  cwd: appRoot,
  env: {
    ...process.env,
    // Ensure the CLI knows it's running inside the app
    QUIVER_APP_MODE: "1",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
