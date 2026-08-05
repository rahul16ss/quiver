#!/usr/bin/env node
/**
 * Bundle + verify the pinned OfficeCLI binary (Phase 6 packaging, ADR-006).
 *
 * Usage:
 *   node scripts/bundle-officecli.mjs --binary <path> --platform <darwin|win32|linux>
 *
 * Verifies the binary's sha256 against the pin in src/harness/office-engine.ts
 * (OFFICECLI_PINS), fails closed on mismatch, copies it into the bundle, and
 * writes the pinned-checksum manifest. Background self-updates are disabled by
 * configuration (the binary is the pinned artifact, not a floating release).
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import * as path from "path";

const PINS = {
  darwin: { version: "1.0.0-quiver-pinned", checksum: "" },
  win32: { version: "1.0.0-quiver-pinned", checksum: "" },
  linux: { version: "1.0.0-quiver-pinned", checksum: "" },
};

function sha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function main() {
  const args = process.argv.slice(2);
  const binary = args[args.indexOf("--binary") + 1];
  const platform = args[args.indexOf("--platform") + 1];
  const outDir = args[args.indexOf("--out") + 1] ?? "bundles/officecli";
  if (!binary || !platform || !PINS[platform]) {
    console.error("usage: bundle-officecli.mjs --binary <path> --platform <darwin|win32|linux> [--out <dir>]");
    process.exit(2);
  }
  if (!existsSync(binary)) {
    console.error(`binary not found: ${binary}`);
    process.exit(1);
  }
  const pin = PINS[platform];
  if (!pin.checksum) {
    console.error(`REFUSING: OFFICECLI_PINS.${platform}.checksum is empty. Populate the audited checksum before bundling (production builds must pin).`);
    process.exit(1);
  }
  const actual = sha256(binary);
  if (actual !== pin.checksum) {
    console.error(`CHECKSUM MISMATCH (fail closed): expected ${pin.checksum}, got ${actual}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `officecli-${platform}-${pin.version}`);
  copyFileSync(binary, dest);
  const manifest = {
    platform,
    version: pin.version,
    checksum: pin.checksum,
    bundledAt: new Date().toISOString(),
    backgroundUpdates: "disabled",
    licenseNotices: ["OfficeCLI — see ATTRIBUTION.md"],
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`bundled ${dest} (sha256 ${actual.slice(0, 16)}…) — background self-updates disabled`);
}

main();