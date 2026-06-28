/**
 * Diff Preview — US-10.3
 *
 * Generates unified diffs for file mutations before approval.
 * Shows unified diff in CLI and side-by-side in GUI.
 * File changes in package files, lockfiles, CI configs, database migrations,
 * or configuration files require explicit approval.
 */

import * as path from "path";

// ─── Risky File Detection ────────────────────────────────────────────

const RISKY_FILE_PATTERNS = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "poetry.lock",
  // CI configs
  ".github/workflows/",
  ".gitlab-ci.yml",
  ".circleci/",
  "Jenkinsfile",
  "azure-pipelines.yml",
  ".travis.yml",
  // Database
  "migrations/",
  "migration/",
  "db/migrate/",
  "prisma/migrations/",
  // Config files
  "tsconfig.json",
  "webpack.config.js",
  "vite.config.js",
  "vite.config.ts",
  "rollup.config.js",
  "babel.config.js",
  ".babelrc",
  "jest.config.js",
  "jest.config.ts",
  "vitest.config.ts",
  "playwright.config.ts",
  "next.config.js",
  "next.config.mjs",
  "nuxt.config.ts",
  "remix.config.js",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  // Security
  ".gitignore",
  ".npmrc",
  ".yarnrc",
  "Makefile",
  "CMakeLists.txt",
];

/**
 * Check if a file path is considered risky (requires explicit approval).
 */
export function isRiskyFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);

  for (const pattern of RISKY_FILE_PATTERNS) {
    if (pattern.includes("/")) {
      // Directory-based pattern — check if path contains it
      if (normalized.includes(pattern)) return true;
    } else {
      // Filename pattern — check basename
      if (basename === pattern) return true;
    }
  }

  return false;
}

// ─── Unified Diff Generation ─────────────────────────────────────────

/**
 * Generate a unified diff between two strings.
 * Uses a simple line-by-line comparison algorithm (Myers-like).
 */
export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Compute LCS-based diff
  const diff = computeLineDiff(oldLines, newLines);

  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  const body = diff
    .map((line) => {
      if (line.type === "context") return ` ${line.content}`;
      if (line.type === "add") return `+${line.content}`;
      if (line.type === "remove") return `-${line.content}`;
      return line.content; // hunk headers
    })
    .join("\n");

  return header + body;
}

/**
 * Generate a diff for a new file creation.
 */
export function generateFileCreationDiff(filePath: string, content: string): string {
  const lines = content.split("\n");
  const header = `--- /dev/null\n+++ b/${filePath}\n`;
  const body = lines.map((line) => `+${line}`).join("\n");
  return header + body;
}

// ─── Line Diff Algorithm ─────────────────────────────────────────────

interface DiffLine {
  type: "context" | "add" | "remove" | "hunk";
  content: string;
}

/**
 * Compute a line-level diff using LCS (Longest Common Subsequence).
 * Produces unified diff output with hunk headers.
 */
function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const lcs: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  // Backtrack to produce diff
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldStart = 0;
  let newStart = 0;
  let inHunk = false;
  let hunkOldStart = 0;
  let hunkNewStart = 0;
  let hunkOldCount = 0;
  let hunkNewCount = 0;
  const hunkLines: DiffLine[] = [];

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      if (inHunk) {
        hunkLines.push({ type: "context", content: oldLines[i] });
        hunkOldCount++;
        hunkNewCount++;
      }
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      if (!inHunk) {
        inHunk = true;
        hunkOldStart = i + 1;
        hunkNewStart = j + 1;
        hunkOldCount = 0;
        hunkNewCount = 0;
      }
      hunkLines.push({ type: "remove", content: oldLines[i] });
      hunkOldCount++;
      i++;
    } else {
      if (!inHunk) {
        inHunk = true;
        hunkOldStart = i + 1;
        hunkNewStart = j + 1;
        hunkOldCount = 0;
        hunkNewCount = 0;
      }
      hunkLines.push({ type: "add", content: newLines[j] });
      hunkNewCount++;
      j++;
    }
  }

  while (i < m) {
    if (!inHunk) {
      inHunk = true;
      hunkOldStart = i + 1;
      hunkNewStart = j + 1;
      hunkOldCount = 0;
      hunkNewCount = 0;
    }
    hunkLines.push({ type: "remove", content: oldLines[i] });
    hunkOldCount++;
    i++;
  }

  while (j < n) {
    if (!inHunk) {
      inHunk = true;
      hunkOldStart = i + 1;
      hunkNewStart = j + 1;
      hunkOldCount = 0;
      hunkNewCount = 0;
    }
    hunkLines.push({ type: "add", content: newLines[j] });
    hunkNewCount++;
    j++;
  }

  if (inHunk && hunkLines.length > 0) {
    result.push({
      type: "hunk",
      content: `@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`,
    });
    result.push(...hunkLines);
  }

  return result;
}

// ─── CLI Formatting ───────────────────────────────────────────────────

/**
 * Format a unified diff for CLI display with colors.
 * Uses ANSI escape codes for colored output.
 */
export function formatDiffForCLI(diff: string): string {
  const lines = diff.split("\n");
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const CYAN = "\x1b[36m";
  const GRAY = "\x1b[90m";
  const RESET = "\x1b[0m";

  return lines
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return `${CYAN}${line}${RESET}`;
      }
      if (line.startsWith("@@")) {
        return `${GRAY}${line}${RESET}`;
      }
      if (line.startsWith("+")) {
        return `${GREEN}${line}${RESET}`;
      }
      if (line.startsWith("-")) {
        return `${RED}${line}${RESET}`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Format a diff for GUI side-by-side display.
 * Returns structured data for rendering.
 */
export function formatDiffForGUI(
  oldContent: string,
  newContent: string,
): { left: DiffLine[]; right: DiffLine[] } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff = computeLineDiff(oldLines, newLines);

  const left: DiffLine[] = [];
  const right: DiffLine[] = [];

  for (const line of diff) {
    if (line.type === "hunk") {
      left.push(line);
      right.push(line);
    } else if (line.type === "context") {
      left.push(line);
      right.push(line);
    } else if (line.type === "remove") {
      left.push(line);
      right.push({ type: "context", content: "" });
    } else if (line.type === "add") {
      left.push({ type: "context", content: "" });
      right.push(line);
    }
  }

  return { left, right };
}