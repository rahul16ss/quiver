import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { wrapUntrustedFile } from "../prompts/security.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";

// Extensions that are natively text — read as UTF-8.
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".sql",
  ".graphql",
  ".proto",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".log",
]);

export const tool: Tool = {
  name: "view_file",
  description:
    "Reads a file and returns its contents. " +
    "Text files (.txt, .md, .csv, .json, source code, etc.) are returned as raw text. " +
    "All other files (images, PDFs, Office documents, etc.) are returned as [File: path] markers — " +
    "the harness encodes them as base64 and the model sees the raw file natively. " +
    "No text extraction, no rendering, no lossy parsing. " +
    "Supports optional line range selection for text files.",
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path to the file to read."),
    startLine: z.number().optional().describe("Starting line number (1-based, text files only)."),
    endLine: z
      .number()
      .optional()
      .describe("Ending line number (1-based, inclusive, text files only)."),
    showLineNumbers: z
      .boolean()
      .optional()
      .describe("Whether to prepend line numbers (text files only). Default: true."),
  }),
  execute: async ({ filePath, startLine, endLine, showLineNumbers }) => {
    try {
      const resolvedPath = assertToolPathAllowed(filePath, "read").absolutePath;
      const ext = path.extname(resolvedPath).toLowerCase();

      // Text files: read raw UTF-8 content
      if (TEXT_EXTENSIONS.has(ext) || !ext) {
        const content = await fs.readFile(resolvedPath, "utf8");
        const lines = content.split("\n");
        const totalLines = lines.length;
        const start = Math.max(1, startLine || 1);
        const end = Math.min(totalLines, endLine || (startLine ? startLine + 1999 : 2000));
        const selectedLines = lines.slice(start - 1, end);
        const useLineNumbers = showLineNumbers !== false;

        let formatted: string;
        if (useLineNumbers) {
          const padWidth = String(end).length;
          formatted = selectedLines
            .map((line, i) => `${String(start + i).padStart(padWidth, " ")}│ ${line}`)
            .join("\n");
        } else {
          formatted = selectedLines.join("\n");
        }

        const header = `[File: ${resolvedPath}] [Lines ${start}-${end} of ${totalLines}]${end < totalLines ? ` (use startLine=${end + 1} to continue)` : ""}\n`;
        return wrapUntrustedFile(resolvedPath, header + formatted);
      }

      // Everything else (images, PDFs, Office docs, binaries): return [File: path]
      // The harness encodes the raw file as base64 and the model sees it natively.
      return `[File: ${resolvedPath}]`;
    } catch (error: any) {
      throw new Error(`Failed to read file at ${filePath}: ${error.message}`);
    }
  },
};
