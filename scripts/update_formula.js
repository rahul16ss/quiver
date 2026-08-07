#!/usr/bin/env node
/**
 * Update the Homebrew formula (Formula/quiver.rb) to point at the latest
 * release tag. Run automatically by the release GitHub Actions workflow on
 * every `v*` tag push, or manually:
 *
 *   node scripts/update_formula.js v1.0.0
 *
 * The script:
 *   1. Reads the tag from argv (or the latest git tag)
 *   2. Downloads the tarball from the GitHub archive URL
 *   3. Computes the SHA-256
 *   4. Rewrites Formula/quiver.rb with the new url + sha256 + version
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import * as path from "path";

const REPO = "rahul16ss/quiver";
const FORMULA_PATH = path.resolve(process.cwd(), "Formula", "quiver.rb");

function getTag() {
  const arg = process.argv[2];
  if (arg) return arg.startsWith("v") ? arg : `v${arg}`;
  // Fall back to the latest git tag
  return execSync("git describe --tags --abbrev=0", { encoding: "utf8" }).trim();
}

function fetchTarballSha256(url) {
  // Use curl to download and pipe to sha256sum
  const result = execSync(`curl -sL "${url}" | sha256sum`, {
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  return result.split(/\s+/)[0];
}

function updateFormula(tag, sha256) {
  const version = tag.replace(/^v/, "");
  const url = `https://github.com/${REPO}/archive/${tag}.tar.gz`;

  let formula = readFileSync(FORMULA_PATH, "utf8");

  // Replace the url line
  formula = formula.replace(/url\s+"https:\/\/github\.com\/[^"]+"/, `url "${url}"`);

  // Replace the sha256 line
  formula = formula.replace(/sha256\s+"[a-f0-9]+"/, `sha256 "${sha256}"`);

  // Replace the version in the test block
  formula = formula.replace(
    /assert_match\s+"[^"]+",\s*shell_output/,
    `assert_match "${version}", shell_output`,
  );

  writeFileSync(FORMULA_PATH, formula, "utf8");
  console.log(`Updated Formula/quiver.rb → ${tag} (sha256: ${sha256.substring(0, 16)}…)`);
}

function main() {
  const tag = getTag();
  console.log(`Updating formula for tag: ${tag}`);
  const url = `https://github.com/${REPO}/archive/${tag}.tar.gz`;
  const sha256 = fetchTarballSha256(url);
  updateFormula(tag, sha256);
  console.log("Done. Commit and push to update the Homebrew tap.");
}

main();
