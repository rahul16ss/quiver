import { exec, execFile } from "child_process";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";

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
      const stats = await import("fs").then((fs) => fs.promises.stat(dir));
      if (!stats.isDirectory()) {
        return `Error: '${dir}' is not a directory.`;
      }
    } catch {
      return `Error: Directory '${dir}' does not exist.`;
    }

    // Check ripgrep availability
    const rgAvailable = await new Promise<boolean>((resolve) => {
      exec("which rg", { timeout: 2000 }, (err, stdout) => {
        resolve(!err && stdout.trim().length > 0);
      });
    });

    // Build command args as array (no shell interpolation) for security
    if (rgAvailable) {
      const rgArgs: string[] = [
        "--line-number",
        "--no-heading",
        "--color=never",
      ];
      if (ignoreCase) rgArgs.push("-i");
      if (glob) rgArgs.push("-g", glob);
      rgArgs.push("-m", String(limit));
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
            resolve(formatSearchOutput(output, pattern, glob, limit, dir));
          },
        );
      });
    }

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
  },
};

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
