import { exec, execFile, execSync } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { hasBinary } from "../utils/find_binary.js";

export const tool: Tool = {
  name: "grep_search",
  description:
    "Searches file contents using ripgrep (rg) or grep. Returns matching lines with file paths and line numbers. " +
    "Essential for finding usages, definitions, and patterns across a codebase. " +
    "Supports regex patterns and file glob filtering.",
  parameters: z.object({
    pattern: z
      .string()
      .describe(
        "The search pattern (regex supported). Example: 'function\\s+handleRequest' or 'TODO|FIXME'.",
      ),
    directory: z
      .string()
      .optional()
      .describe(
        "The directory to search in. Defaults to current directory ('.').",
      ),
    glob: z
      .string()
      .optional()
      .describe(
        "File glob filter to narrow search. Example: '*.ts' or '*.{js,ts}'.",
      ),
    ignoreCase: z
      .boolean()
      .optional()
      .describe("Case-insensitive search. Default: false."),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of matching lines to return. Default: 50."),
  }),
  execute: async ({ pattern, directory, glob, ignoreCase, maxResults }) => {
    const dir = path.resolve(directory || ".");
    const limit = maxResults || 50;

    // Validate directory exists and is a directory (prevents path injection)
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        return `Error: '${dir}' is not a directory.`;
      }
    } catch {
      return `Error: Directory '${dir}' does not exist.`;
    }

    // Check ripgrep availability (cross-platform)
    const rgAvailable = hasBinary("rg");

    // Build command args as array (no shell interpolation) for security
    if (rgAvailable) {
      const rgArgs: string[] = [
        "--line-number",
        "--no-heading",
        "--color=never",
      ];
      if (ignoreCase) rgArgs.push("-i");
      if (glob) rgArgs.push("-g", glob);
      rgArgs.push("--", pattern, dir);

      return new Promise((resolve) => {
        execFile(
          "rg",
          rgArgs,
          { maxBuffer: 1024 * 1024 * 10 },
          (error, stdout, stderr) => {
            const output = stdout.trim();
            if (!output) {
              resolve(`No matches found for pattern '${pattern}' in ${dir}.`);
              return;
            }
            // Apply total limit across all files (rg -m limits per-file)
            const lines = output.split("\n").slice(0, limit);
            resolve(
              formatSearchOutput(lines.join("\n"), pattern, glob, limit, dir),
            );
          },
        );
      });
    }

    // Check grep availability (may not exist on Windows)
    const grepAvailable = hasBinary("grep");

    if (grepAvailable) {
      // Fall back to grep using execFile (no shell injection)
      const grepArgs: string[] = ["-rn"];
      if (ignoreCase) grepArgs.push("-i");
      if (glob) grepArgs.push(`--include=${glob}`);
      grepArgs.push("--", pattern, dir);

      return new Promise((resolve) => {
        execFile(
          "grep",
          grepArgs,
          { maxBuffer: 1024 * 1024 * 10 },
          (error, stdout, stderr) => {
            const output = stdout.trim();
            if (!output) {
              resolve(`No matches found for pattern '${pattern}' in ${dir}.`);
              return;
            }
            // Apply limit
            const lines = output.split("\n").slice(0, limit);
            resolve(
              formatSearchOutput(lines.join("\n"), pattern, glob, limit, dir),
            );
          },
        );
      });
    }

    // Pure-TypeScript fallback: no rg or grep available (e.g. Windows without rg)
    return pureTSSearch(pattern, dir, glob, ignoreCase ?? false, limit);
  },
};

// ---------------------------------------------------------------------------
// Pure-TypeScript fallback implementation
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|\\]/g, "\\$&");
}

/**
 * Convert a glob pattern to a regex for matching relative file paths.
 * Supports: **, *, ?, {a,b,c}, [class], and literal characters.
 * Mirrors the implementation in glob.ts.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") {
          i++;
        }
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        regex += "\\{";
        i++;
      } else {
        const options = pattern.substring(i + 1, end);
        regex += `(?:${options
          .split(",")
          .map((o) => escapeRegex(o))
          .join("|")})`;
        i = end + 1;
      }
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        regex += "\\[";
        i++;
      } else {
        regex += pattern.substring(i, end + 1);
        i = end + 1;
      }
    } else {
      regex += escapeRegex(ch);
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

/**
 * Load .gitignore patterns from the root directory.
 */
async function loadGitignorePatterns(rootDir: string): Promise<RegExp[]> {
  const patterns: RegExp[] = [];
  try {
    const content = await fs.readFile(path.join(rootDir, ".gitignore"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (trimmed.endsWith("/")) {
        patterns.push(new RegExp(`^${escapeRegex(trimmed.slice(0, -1))}/`));
      } else {
        patterns.push(new RegExp(`^${escapeRegex(trimmed)}$`));
        patterns.push(new RegExp(`^${escapeRegex(trimmed)}/`));
      }
    }
  } catch {
    // No .gitignore — that's fine
  }

  // Always ignore common directories
  patterns.push(/^node_modules\//);
  patterns.push(/^\.git\//);

  return patterns;
}

function shouldIgnore(relPath: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(relPath) || p.test(relPath + "/")) {
      return true;
    }
  }
  return false;
}

interface MatchResult {
  filePath: string;
  lineNum: number;
  content: string;
}

/**
 * Recursively walk a directory, read each file, and search for the regex pattern.
 * Returns matching lines with file paths and line numbers.
 */
async function pureTSSearch(
  pattern: string,
  rootDir: string,
  globFilter: string | undefined,
  ignoreCase: boolean,
  limit: number,
): Promise<string> {
  // Compile the search regex
  let searchRe: RegExp;
  try {
    searchRe = new RegExp(pattern, ignoreCase ? "gi" : "g");
  } catch {
    return `Error: Invalid regex pattern '${pattern}'.`;
  }

  // Compile the glob filter if provided
  const globRe = globFilter ? globToRegex(globFilter) : null;

  // Load gitignore patterns
  const ignorePatterns = await loadGitignorePatterns(rootDir);

  const matches: MatchResult[] = [];
  const maxDepth = 20;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (matches.length >= limit) return;

    let entries: import("fs").Dirent[];
    try {
      entries = (await fs.readdir(dir, {
        withFileTypes: true,
      })) as unknown as import("fs").Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= limit) return;

      const entryName = String(entry.name);
      const fullPath = path.join(dir, entryName);
      const relPath = path.relative(rootDir, fullPath);

      // Check gitignore
      if (shouldIgnore(relPath, ignorePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        // Skip common non-useful directories
        if (
          entryName === "node_modules" ||
          entryName === ".git" ||
          entryName === "dist"
        ) {
          continue;
        }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        // Apply glob filter on the relative path
        if (globRe && !globRe.test(relPath)) {
          continue;
        }

        // Read file and search line by line
        let content: string;
        try {
          content = await fs.readFile(fullPath, "utf8");
        } catch {
          // Skip binary or unreadable files
          continue;
        }

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= limit) break;

          // Reset lastIndex for each line (global flag)
          searchRe.lastIndex = 0;
          if (searchRe.test(lines[i])) {
            matches.push({
              filePath: fullPath,
              lineNum: i + 1,
              content: lines[i],
            });
          }
        }
      }
    }
  }

  await walk(rootDir, 0);

  if (matches.length === 0) {
    return `No matches found for pattern '${pattern}' in ${rootDir}.`;
  }

  // Format output as filepath:linenumber: content (matching grep/rg format)
  const formatted = matches
    .map((m) => {
      const relPath = path.relative(process.cwd(), m.filePath) || m.filePath;
      return `${relPath}:${m.lineNum}: ${m.content}`;
    })
    .join("\n");

  const header = `Found ${matches.length} match${matches.length === 1 ? "" : "es"} for '${pattern}'${globFilter ? ` in ${globFilter}` : ""}${matches.length >= limit ? ` (showing first ${limit})` : ""}:\n\n`;
  return header + formatted;
}

function formatSearchOutput(
  output: string,
  pattern: string,
  glob: string | undefined,
  limit: number,
  dir: string,
): string {
  const lines = output.split("\n");
  const truncated = lines.length >= limit;
  const formatted = lines
    .map((line) => {
      // Format: filepath:linenumber:content
      const parts = line.split(":");
      if (parts.length >= 3) {
        const filePath = parts[0];
        const lineNum = parts[1];
        const content = parts.slice(2).join(":");
        const relPath = path.relative(process.cwd(), filePath) || filePath;
        return `${relPath}:${lineNum}: ${content}`;
      }
      return line;
    })
    .join("\n");

  const header = `Found ${lines.length} match${lines.length === 1 ? "" : "es"} for '${pattern}'${glob ? ` in ${glob}` : ""}${truncated ? ` (showing first ${limit})` : ""}:\n\n`;
  return header + formatted;
}
