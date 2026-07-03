import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js"
import { assertToolPathAllowed } from "../security/tool_paths.js";;

/**
 * Glob — find files by name pattern.
 * Supports standard glob syntax: ** for recursive matching, {} for alternation, * and ? for wildcards.
 * Respects .gitignore by default (via ripgrep --files flag if available, falls back to manual walk).
 * Returns file paths sorted by modification time (newest first).
 */

interface FileEntry {
  path: string;
  mtime: number;
}

/**
 * Convert a glob pattern to a regex pattern for matching relative paths.
 * Supports: **, *, ?, {a,b,c}, and literal characters.
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** — match any number of path segments (including zero)
        regex += ".*";
        i += 2;
        // Skip optional trailing /
        if (pattern[i] === "/") {
          i++;
        }
      } else {
        // * — match any characters except /
        regex += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (ch === "{") {
      // {a,b,c} — alternation
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
      // Character class — pass through
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

function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|\\]/g, "\\$&");
}

/**
 * Recursively walk a directory and collect file paths.
 * Optionally respect .gitignore patterns.
 */
async function walkDir(
  rootDir: string,
  maxDepth: number = 20,
  respectGitignore: boolean = true,
): Promise<FileEntry[]> {
  const results: FileEntry[] = [];

  // Load .gitignore patterns if needed
  let ignorePatterns: RegExp[] = [];
  if (respectGitignore) {
    ignorePatterns = await loadGitignorePatterns(rootDir);
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: import("fs").Dirent[];
    try {
      entries = (await fs.readdir(dir, {
        withFileTypes: true,
      })) as unknown as import("fs").Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryName = String(entry.name);
      const fullPath = path.join(dir, entryName);
      const relPath = path.relative(rootDir, fullPath);

      // Check gitignore
      if (
        respectGitignore &&
        shouldIgnore(relPath, entry.isDirectory(), ignorePatterns)
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        // Skip common non-useful directories
        if (
          entryName === "node_modules" ||
          entryName === ".git" ||
          entryName === "dist"
        ) {
          // Still allow if the user explicitly searches in them (handled by pattern matching later)
          if (!respectGitignore) {
            await walk(fullPath, depth + 1);
          }
          continue;
        }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          results.push({ path: relPath, mtime: stat.mtimeMs });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  await walk(rootDir, 0);
  return results;
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
      // Convert gitignore pattern to regex (simplified)
      if (trimmed.endsWith("/")) {
        // Directory pattern
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

function shouldIgnore(
  relPath: string,
  isDir: boolean,
  patterns: RegExp[],
): boolean {
  for (const pattern of patterns) {
    if (pattern.test(relPath) || pattern.test(relPath + "/")) {
      return true;
    }
  }
  return false;
}

export const tool: Tool = {
  name: "glob",
  description:
    "Finds files by name pattern matching. Supports standard glob syntax: ** for recursive directory matching, * for wildcard within a path segment, ? for single character, {a,b} for alternation. " +
    "Returns matching file paths sorted by modification time (newest first). " +
    "Respects .gitignore by default. Use this to find files when you know the name pattern but not the exact path.",
  parameters: z.object({
    pattern: z
      .string()
      .describe(
        "Glob pattern to match file paths. Examples: '**/*.ts' (all TS files), 'src/**/*.js' (JS files in src), '*.{json,yaml}' (JSON or YAML in root), 'test*.py' (Python files starting with test).",
      ),
    directory: z
      .string()
      .optional()
      .describe(
        "The directory to search in. Defaults to current directory ('.').",
      ),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of file paths to return. Default: 100."),
  }),
  execute: async ({ pattern, directory, maxResults }) => {
    const dir = path.resolve(directory || ".");

    // Path-policy guard (US-9.2): reject sensitive paths
    try { assertToolPathAllowed(dir, "read"); } catch (e: any) { return `Error: ${e.message}`; }
    const limit = maxResults || 100;

    // Validate directory exists
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        return `Error: '${dir}' is not a directory.`;
      }
    } catch {
      return `Error: Directory '${dir}' does not exist.`;
    }

    // Walk the directory tree
    const files = await walkDir(dir);

    // Convert pattern to regex and filter
    const regex = globToRegex(pattern);
    const matched = files.filter((f) => regex.test(f.path));

    // Sort by modification time (newest first)
    matched.sort((a, b) => b.mtime - a.mtime);

    // Apply limit
    const truncated = matched.length > limit;
    const results = matched.slice(0, limit);

    if (results.length === 0) {
      return `No files matching pattern '${pattern}' found in ${dir}.`;
    }

    const header = `Found ${matched.length} file${matched.length === 1 ? "" : "s"} matching '${pattern}'${truncated ? ` (showing first ${limit})` : ""}:\n\n`;
    const body = results.map((f) => f.path).join("\n");

    return header + body;
  },
};
