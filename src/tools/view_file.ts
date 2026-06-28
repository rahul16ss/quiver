import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { wrapUntrustedFile } from "../prompts/security.js";

export const tool: Tool = {
  name: "view_file",
  description:
    "Reads and returns the contents of a file on the local filesystem. " +
    "Supports optional line range selection and line numbers for precise navigation of large files. " +
    "When viewing a file for the first time, omit startLine/endLine to see the full file (or first 2000 lines if very large).",
  parameters: z.object({
    filePath: z
      .string()
      .describe("The absolute or relative path to the file to read."),
    startLine: z
      .number()
      .optional()
      .describe(
        "Starting line number (1-based). If omitted, starts from line 1.",
      ),
    endLine: z
      .number()
      .optional()
      .describe(
        "Ending line number (1-based, inclusive). If omitted, reads to end of file (max 2000 lines).",
      ),
    showLineNumbers: z
      .boolean()
      .optional()
      .describe("Whether to prepend line numbers. Default: true."),
  }),
  execute: async ({ filePath, startLine, endLine, showLineNumbers }) => {
    try {
      const resolvedPath = path.resolve(filePath);
      const content = await fs.readFile(resolvedPath, "utf8");
      const lines = content.split("\n");
      const totalLines = lines.length;

      const start = Math.max(1, startLine || 1);
      const end = Math.min(
        totalLines,
        endLine || (startLine ? startLine + 1999 : 2000),
      );

      const selectedLines = lines.slice(start - 1, end);
      const useLineNumbers = showLineNumbers !== false;

      let formatted: string;
      if (useLineNumbers) {
        const padWidth = String(end).length;
        formatted = selectedLines
          .map(
            (line, i) =>
              `${String(start + i).padStart(padWidth, " ")}│ ${line}`,
          )
          .join("\n");
      } else {
        formatted = selectedLines.join("\n");
      }

      const header = `[File: ${resolvedPath}] [Lines ${start}-${end} of ${totalLines}]${end < totalLines ? ` (use startLine=${end + 1} to continue)` : ""}\n`;
      // US-9.4: file contents are untrusted data — wrap them in untrusted
      // boundaries so the model never follows instructions embedded inside.
      return wrapUntrustedFile(resolvedPath, header + formatted);
    } catch (error: any) {
      throw new Error(`Failed to read file at ${filePath}: ${error.message}`);
    }
  },
};
