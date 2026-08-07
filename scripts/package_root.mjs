#!/usr/bin/env node
/**
 * Resolve the package root from this script's location, not the caller's cwd.
 * Shared by build/check scripts so repository and package workflows are immune
 * to where the operator or CI runner launched npm.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PACKAGE_JSON = path.join(PACKAGE_ROOT, "package.json");

if (!existsSync(PACKAGE_JSON)) {
  throw new Error(`Quiver package root is broken: missing ${PACKAGE_JSON}`);
}

export const PACKAGE = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));

export function fromPackageRoot(...parts) {
  return path.join(PACKAGE_ROOT, ...parts);
}
