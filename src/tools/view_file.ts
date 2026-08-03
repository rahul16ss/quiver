import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { wrapUntrustedFile } from "../prompts/security.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";

// File types that should be sent to the model as images (base64 image_url
// content parts) rather than text. The model sees the raw image natively —
// no text extraction, no lossy parsing.
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"];

// File types that are natively text — read as UTF-8 with no transformation.
const TEXT_EXTENSIONS = [
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml",
  ".xml", ".html", ".htm", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".sql", ".graphql", ".proto",
  ".env", ".gitignore", ".dockerignore", ".editorconfig",
  ".toml", ".ini", ".cfg", ".conf",
];

// File types that go through officecli (the only lossy path, by design).
const OFFICE_EXTENSIONS = [".docx", ".xlsx", ".pptx"];

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.includes(ext);
}

function isOfficeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return OFFICE_EXTENSIONS.includes(ext);
}

export const tool: Tool = {
  name: "view_file",
  description:
    "Reads and returns the contents of a file on the local filesystem. " +
    "For text files (.txt, .md, .csv, .json, source code, etc.) returns the raw text with optional line numbers. " +
    "For image files (.png, .jpg, .gif, .webp, etc.) returns [Image: path] markers so the model sees the raw image natively — no text extraction. " +
    "For Office documents (.docx, .xlsx, .pptx) use the office_doc tool instead (officecli extracts text/structure). " +
    "For PDFs use the pdf_read tool (renders pages as images for multimodal viewing). " +
    "Supports optional line range selection for large text files.",
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
      const resolvedPath = assertToolPathAllowed(filePath, "read").absolutePath;

      // ── Image files: return [Image: path] marker — model sees raw image ──
      if (isImageFile(resolvedPath)) {
        return `[Image: ${resolvedPath}]`;
      }

      // ── Office files: tell the agent to use office_doc ──
      if (isOfficeFile(resolvedPath)) {
        return `This is an Office document (${path.extname(resolvedPath)}). Use the office_doc tool with action "view" to read it via officecli, which extracts text, outline, and structure.`;
      }

      // ── PDF files: tell the agent to use pdf_read ──
      if (path.extname(resolvedPath).toLowerCase() === ".pdf") {
        return `This is a PDF file. Use the pdf_read tool to render pages as images for multimodal viewing — the model sees the actual page, preserving tables, charts, and layout.`;
      }

      // ── Text files: read raw UTF-8 content ──
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
      return wrapUntrustedFile(resolvedPath, header + formatted);
    } catch (error: any) {
      throw new Error(`Failed to read file at ${filePath}: ${error.message}`);
    }
  },
};
