#!/usr/bin/env node
/**
 * Build the distributable Quiver runtime.
 *
 * This script intentionally locates everything relative to package_root.mjs,
 * never process.cwd(), so `npm --prefix <repo> run build` works from anywhere.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PACKAGE_ROOT, fromPackageRoot } from "./package_root.mjs";

const dist = fromPackageRoot("dist");
const tsc = fromPackageRoot("node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) {
  console.error(`Missing local TypeScript compiler at ${tsc}. Run npm ci first.`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const compile = spawnSync(process.execPath, [tsc, "-p", fromPackageRoot("tsconfig.build.json")], {
  cwd: PACKAGE_ROOT,
  stdio: "inherit",
});
if (compile.status !== 0) process.exit(compile.status ?? 1);

// Runtime assets that TypeScript does not emit. The browser daemon serves
// dist/harness/ui directly; packaged skills are seeded from dist/skills.
const assetPairs = [
  [fromPackageRoot("src", "harness", "ui"), fromPackageRoot("dist", "harness", "ui")],
  [fromPackageRoot("skills"), fromPackageRoot("dist", "skills")],
  [fromPackageRoot("templates"), fromPackageRoot("dist", "templates")],
];

for (const [source, target] of assetPairs) {
  if (!existsSync(source)) {
    console.error(`Required build asset is missing: ${source}`);
    process.exit(1);
  }
  cpSync(source, target, {
    recursive: true,
    filter: (entry) =>
      path.basename(entry) !== ".DS_Store" && path.basename(entry) !== ".quiver-backups",
  });
}

// Some runtime helpers resolve package metadata and dotenv templates one level
// above their compiled module. Include them in dist so a packaged install is
// self-contained.
for (const file of ["package.json", ".env.example", "README.md", "LICENSE"]) {
  const source = fromPackageRoot(file);
  if (!existsSync(source)) {
    console.error(`Required package file is missing: ${source}`);
    process.exit(1);
  }
  cpSync(source, fromPackageRoot("dist", file));
}

// Mark the build reproducibly without timestamps; content changes are captured
// by source control, not by build-time nondeterminism.
writeFileSync(
  fromPackageRoot("dist", "BUILD.json"),
  `${JSON.stringify({ name: "quiver-agent", entry: "cli.js", type: "compiled" }, null, 2)}\n`,
);

const required = [
  "cli.js",
  "harness/launcher.js",
  "harness/daemon.js",
  "harness/ui/index.html",
  "package.json",
];
for (const file of required) {
  if (!existsSync(fromPackageRoot("dist", file))) {
    console.error(`Build verification failed: dist/${file} was not produced.`);
    process.exit(1);
  }
}

console.log(`Built Quiver runtime in ${dist}`);
