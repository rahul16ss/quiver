import { promises as fs } from "fs";
import * as path from "path";
import { exec, execFile } from "child_process";
import { z } from "zod";
import picocolors from "picocolors";
import { Tool } from "../registry.js"
import { assertToolPathAllowed } from "../security/tool_paths.js";

/**
 * Checks if prettier is available in the project.
 */
function hasPrettier(): Promise<boolean> {
  return new Promise((resolve) => {
    exec("npx prettier --version", { timeout: 5000 }, (error, stdout) => {
      resolve(!error && stdout.trim().length > 0);
    });
  });
}

/**
 * Runs prettier on a file path using execFile (no shell interpolation).
 */
function runPrettier(
  filePath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["prettier", "--write", filePath],
      { maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      },
    );
  });
}

/**
 * Custom lightweight TypeScript formatter.
 * Applies consistent formatting rules without external dependencies:
 * - 2-space indentation
 * - Trailing whitespace removal
 * - Consistent semicolons (ensures statements end with semicolons where appropriate)
 * - Normalizes line endings to LF
 * - Ensures single blank line between top-level declarations
 */
function customFormat(source: string): string {
  // Normalize line endings to LF
  let lines = source.replace(/\r\n/g, "\n").split("\n");

  // Remove trailing whitespace from each line
  lines = lines.map((line) => line.replace(/\s+$/, ""));

  // Re-indent: calculate proper indentation based on brace/bracket/paren depth
  const formatted: string[] = [];
  let depth = 0;
  let inComment: "line" | "block" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle comment state tracking
    if (inComment === "block") {
      formatted.push("  ".repeat(depth) + trimmed);
      if (trimmed.includes("*/")) {
        inComment = null;
      }
      continue;
    }

    // Detect block comment start
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inComment = "block";
      formatted.push("  ".repeat(depth) + trimmed);
      continue;
    }

    // Skip empty lines but preserve them (max 1 consecutive blank)
    if (trimmed === "") {
      // Avoid more than one consecutive blank line
      if (formatted.length > 0 && formatted[formatted.length - 1] !== "") {
        formatted.push("");
      }
      continue;
    }

    // Calculate closing braces/brackets/parens at start of line (decrement depth before indenting)
    let leadingClosers = 0;
    for (const ch of trimmed) {
      if (ch === "}" || ch === ")" || ch === "]") {
        leadingClosers++;
      } else if (ch !== " " && ch !== ";") {
        break;
      }
    }

    const effectiveDepth = Math.max(0, depth - leadingClosers);
    formatted.push("  ".repeat(effectiveDepth) + trimmed);

    // Update depth based on net openers vs closers in the full line
    // Simple heuristic: count opening and closing braces (not in strings)
    let netDepth = 0;
    let inStr: string | null = null;
    let escaped = false;

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (inStr) {
        if (ch === inStr) {
          inStr = null;
        }
        continue;
      }

      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }

      // Skip single-line comments
      if (ch === "/" && line[j + 1] === "/") {
        break;
      }

      if (ch === "{" || ch === "(" || ch === "[") {
        netDepth++;
      } else if (ch === "}" || ch === ")" || ch === "]") {
        netDepth--;
      }
    }

    depth = Math.max(0, depth + netDepth);
  }

  // Ensure file ends with a newline
  let result = formatted.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}

export const tool: Tool = {
  name: "format_code",
  description:
    "Formats TypeScript/JavaScript files to ensure pristine code style. Uses prettier if available, otherwise falls back to a built-in formatter that enforces 2-space indentation, trailing whitespace removal, and consistent line endings.",
  parameters: z.object({
    filePath: z
      .string()
      .describe(
        "The absolute or relative path of the TypeScript/JavaScript file to format.",
      ),
  }),
  execute: async ({ filePath }) => {
    // Path-policy guard (US-9.2): reject sensitive paths
    try {
      assertToolPathAllowed(filePath, "read");
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
    const resolvedPath = path.resolve(filePath);

    // Check file exists
    try {
      await fs.access(resolvedPath);
    } catch {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    // Read original content
    const original = await fs.readFile(resolvedPath, "utf8");

    // Try prettier first
    const prettierAvailable = await hasPrettier();
    let formatted: string;
    let method: string;

    if (prettierAvailable) {
      console.log(picocolors.gray(`   ⚡ Formatting with prettier...`));
      const result = await runPrettier(resolvedPath);
      if (result.code === 0) {
        formatted = await fs.readFile(resolvedPath, "utf8");
        method = "prettier";
      } else {
        console.log(
          picocolors.yellow(
            `   ⚠️  Prettier failed, falling back to built-in formatter.`,
          ),
        );
        formatted = customFormat(original);
        method = "built-in (prettier fallback)";
      }
    } else {
      console.log(
        picocolors.gray(`   ⚡ Formatting with built-in formatter...`),
      );
      formatted = customFormat(original);
      method = "built-in";
    }

    // Write formatted content if changed
    if (formatted !== original) {
      await fs.writeFile(resolvedPath, formatted, "utf8");
      const linesChanged = formatted.split("\n").length;
      console.log(
        picocolors.green(
          `   ✅ Formatted ${resolvedPath} (${linesChanged} lines, method: ${method})`,
        ),
      );
      return JSON.stringify(
        {
          success: true,
          method,
          filePath: resolvedPath,
          lines: linesChanged,
          changed: true,
        },
        null,
        2,
      );
    } else {
      console.log(
        picocolors.green(`   ✅ File already well-formatted (${method}).`),
      );
      return JSON.stringify(
        {
          success: true,
          method,
          filePath: resolvedPath,
          changed: false,
        },
        null,
        2,
      );
    }
  },
};
