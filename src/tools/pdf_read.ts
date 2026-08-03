/**
* PDF Reader Tool — multimodal PDF page reading.
*
* Renders PDF pages to PNG images and returns [File: path] markers
* so the agent loop can encode them as vision content for the model.
*
* This is a multimodal approach: the model "sees" the page as an image,
* preserving tables, charts, layout, and visual context that text
* extraction destroys.
*
* Rendering backends (tried in order):
*   1. PyMuPDF (fitz) — Python, fast, high-quality. Primary.
*   2. pdftoppm (poppler) — CLI, widely available. Fallback.
*
* If neither is available, the tool returns a clear error with install
* instructions.
*/

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { z } from "zod";
import type { Tool } from "../registry.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────

interface PdfRenderResult {
  pages: Array<{ pageNumber: number; pngPath: string; width: number; height: number }>;
  totalPages: number;
  renderedPages: number;
  backend: string;
}

// ─── Backend Detection ────────────────────────────────────────────────

let cachedBackend: string | null | undefined;

async function detectBackend(): Promise<string | null> {
  if (cachedBackend !== undefined) return cachedBackend;

  // 1. Check PyMuPDF (fitz) via python3
  try {
    execFileSync("python3", ["-c", "import fitz; print(fitz.version[0])"], {
        stdio: "pipe",
        timeout: 5000,
    });
    cachedBackend = "pymupdf";
    return cachedBackend;
  } catch {
    // PyMuPDF not available
  }

  // 2. Check pdftoppm (poppler)
  try {
    execFileSync("which", ["pdftoppm"], { stdio: "pipe", timeout: 5000 });
    cachedBackend = "pdftoppm";
    return cachedBackend;
  } catch {
    // pdftoppm not available
  }

  cachedBackend = null;
  return null;
}

// ─── PDF Info ─────────────────────────────────────────────────────────

async function getPdfPageCount(filePath: string): Promise<number> {
  const backend = await detectBackend();

  if (backend === "pymupdf") {
    try {
      const { stdout } = await execFileAsync(
        "python3",
        ["-c", `import fitz; doc=fitz.open("${filePath.replace(/"/g, '\\"')}"); print(doc.page_count); doc.close()`],
        { timeout: 10000 },
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  if (backend === "pdftoppm") {
    try {
      const { stdout } = await execFileAsync("pdfinfo", [filePath], { timeout: 10000 });
      const match = stdout.match(/Pages:\s+(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }

  return 0;
}

// ─── Rendering ────────────────────────────────────────────────────────

/**
* Render PDF pages to PNG using PyMuPDF.
* Writes a Python script to a temp file and executes it — safer than
* inline string interpolation for paths with special characters.
*/
async function renderWithPyMuPDF(
  filePath: string,
  startPage: number,
  endPage: number,
  dpi: number,
  outputDir: string,
): Promise<PdfRenderResult> {
  const scriptPath = path.join(outputDir, "_render.py");
  const script = [
    "import fitz",
    "import sys",
    "import json",
    "",
    "pdf_path = sys.argv[1]",
    "output_dir = sys.argv[2]",
    "start = int(sys.argv[3])",
    "end = int(sys.argv[4])",
    "dpi = int(sys.argv[5])",
    "",
    "doc = fitz.open(pdf_path)",
    "total = doc.page_count",
    "results = []",
    "",
    "for page_num in range(start, min(end, total) + 1):",
    "    page = doc[page_num - 1]",
    "    zoom = dpi / 72.0",
    "    mat = fitz.Matrix(zoom, zoom)",
    "    pix = page.get_pixmap(matrix=mat)",
    "    out_path = f'{output_dir}/page-{page_num:04d}.png'",
    "    pix.save(out_path)",
    "    results.append({",
    "        'pageNumber': page_num,",
    "        'pngPath': out_path,",
    "        'width': pix.width,",
    "        'height': pix.height,",
    "    })",
    "",
    "doc.close()",
    "print(json.dumps({'pages': results, 'totalPages': total}))",
  ].join("\n");

  fs.writeFileSync(scriptPath, script, "utf8");

  try {
    const { stdout } = await execFileAsync(
      "python3",
      [scriptPath, filePath, outputDir, String(startPage), String(endPage), String(dpi)],
      { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
    );

    const data = JSON.parse(stdout.trim());
    return {
      pages: data.pages,
      totalPages: data.totalPages,
      renderedPages: data.pages.length,
      backend: "pymupdf",
    };
  } finally {
    // Clean up the script file
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

/**
* Render PDF pages to PNG using pdftoppm (poppler).
*/
async function renderWithPdftoppm(
  filePath: string,
  startPage: number,
  endPage: number,
  dpi: number,
  outputDir: string,
): Promise<PdfRenderResult> {
  const prefix = path.join(outputDir, "page");
  const args = [
    "-png",
    "-r", String(dpi),
    "-f", String(startPage),
    "-l", String(endPage),
    filePath,
    prefix,
  ];

  await execFileAsync("pdftoppm", args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });

  // pdftoppm names files like page-01.png, page-02.png, etc.
  const files = fs.readdirSync(outputDir)
  .filter(f => f.startsWith("page-") && f.endsWith(".png"))
  .sort();

  const totalPages = await getPdfPageCount(filePath);
  const pages = files.map((f, idx) => {
      const pngPath = path.join(outputDir, f);
      // We don't have dimensions from pdftoppm, so we'll read them from the PNG header
      const stat = fs.statSync(pngPath);
      return {
        pageNumber: startPage + idx,
        pngPath,
        width: 0, // unknown without parsing PNG
        height: 0,
        _size: stat.size,
      };
  });

  return {
    pages,
    totalPages,
    renderedPages: pages.length,
    backend: "pdftoppm",
  };
}

// ─── Tool Definition ──────────────────────────────────────────────────

export const tool: Tool = {
  name: "pdf_read",
  description:
  "Read PDF files by rendering pages to images for multimodal vision. " +
  "The model sees the page as an image, preserving tables, charts, layout, and visual context. " +
  "Returns [File: path] markers for each rendered page — the agent loop encodes these as vision content. " +
  "Use this to read SEC filings, transcripts, research reports, presentations, or any PDF document. " +
  "Supports page ranges (e.g., read pages 5-10 of a 200-page filing).",

  parameters: z.object({
      file: z
      .string()
      .describe("Path to the PDF file. Can be relative to cwd."),
      pages: z
      .string()
      .optional()
      .describe(
        "Page range to read. Formats: '1' (single page), '1-5' (range), '1,3,5' (specific pages), 'all' (entire document). " +
        "Defaults to '1-5' (first 5 pages) to avoid rendering huge documents. Use 'all' only when you need the entire PDF.",
      ),
      dpi: z
      .number()
      .optional()
      .describe(
        "Render resolution in DPI. Higher = sharper but larger images. " +
        "Default 150 (good for text + tables). Use 200-300 for detailed tables or small text.",
      ),
      maxPages: z
      .number()
      .optional()
      .describe(
        "Maximum number of pages to render in a single call. Default 10. " +
        "Prevents accidentally rendering 500-page filings. Call the tool again for the next batch.",
      ),
  }),

  execute: async (args: any) => {
    // Path-policy guard
    try {
      assertToolPathAllowed(args.file, "read");
    } catch (e: any) {
      return `Error: ${e.message}`;
    }

    const filePath = path.resolve(args.file);
    if (!fs.existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    // Validate it's a PDF (magic bytes: %PDF)
    try {
      const fd = fs.openSync(filePath, "r");
      const header = Buffer.alloc(5);
      fs.readSync(fd, header, 0, 5, 0);
      fs.closeSync(fd);
      if (header.toString("ascii") !== "%PDF-") {
        return `Error: Not a valid PDF file (missing %PDF header): ${filePath}`;
      }
    } catch (e: any) {
      return `Error: Could not read file header: ${e.message}`;
    }

    // Detect rendering backend
    const backend = await detectBackend();
    if (!backend) {
      return (
        "Error: No PDF rendering backend found. Install one of:\n" +
        "  • PyMuPDF: pip3 install pymupdf\n" +
        "  • poppler: brew install poppler (macOS) or apt install poppler-utils (Linux)"
      );
    }

    // Parse page range
    const pageArg = args.pages || "1-5";
    const maxPages = args.maxPages || 10;
    const dpi = args.dpi || 150;

    const totalPages = await getPdfPageCount(filePath);
    if (totalPages === 0) {
      return `Error: Could not determine page count for ${filePath}. The file may be corrupted.`;
    }

    let pagesToRender: number[] = [];

    if (pageArg === "all") {
      const count = Math.min(totalPages, maxPages);
      pagesToRender = Array.from({ length: count }, (_, i) => i + 1);
    } else if (pageArg.includes(",")) {
      // Specific pages: 1,3,5
      pagesToRender = pageArg
      .split(",")
      .map((p: string) => parseInt(p.trim(), 10))
      .filter((p: number) => !isNaN(p) && p >= 1 && p <= totalPages)
      .slice(0, maxPages);
    } else if (pageArg.includes("-")) {
      // Range: 1-5
      const [startStr, endStr] = pageArg.split("-");
      const start = Math.max(1, parseInt(startStr.trim(), 10) || 1);
      const end = Math.min(totalPages, parseInt(endStr.trim(), 10) || totalPages);
      const count = Math.min(end - start + 1, maxPages);
      pagesToRender = Array.from({ length: count }, (_, i) => start + i);
    } else {
      // Single page
      const page = parseInt(pageArg.trim(), 10);
      if (isNaN(page) || page < 1 || page > totalPages) {
        return `Error: Invalid page number ${pageArg}. Document has ${totalPages} pages.`;
      }
      pagesToRender = [page];
    }

    if (pagesToRender.length === 0) {
      return `Error: No valid pages to render. Document has ${totalPages} pages.`;
    }

    // Create temp output directory
    const sessionId = process.pid;
    const outputDir = path.join(os.tmpdir(), `quiver-pdf-${sessionId}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // Render
    let renderResult: PdfRenderResult;
    try {
      if (backend === "pymupdf") {
        const startPage = pagesToRender[0];
        const endPage = pagesToRender[pagesToRender.length - 1];
        renderResult = await renderWithPyMuPDF(filePath, startPage, endPage, dpi, outputDir);
        // Filter to only the requested pages (in case of range overlap)
        const pageSet = new Set(pagesToRender);
        renderResult.pages = renderResult.pages.filter((p) => pageSet.has(p.pageNumber));
      } else {
        const startPage = pagesToRender[0];
        const endPage = pagesToRender[pagesToRender.length - 1];
        renderResult = await renderWithPdftoppm(filePath, startPage, endPage, dpi, outputDir);
        const pageSet = new Set(pagesToRender);
        renderResult.pages = renderResult.pages.filter((p) => pageSet.has(p.pageNumber));
      }
    } catch (e: any) {
      return `Error: Failed to render PDF: ${e.message}`;
    }

    if (renderResult.pages.length === 0) {
      return `Error: No pages were rendered. Check the PDF file and page range.`;
    }

    // Build result text with [File:] markers
    const lines: string[] = [];
    lines.push(`PDF: ${path.basename(filePath)}`);
    lines.push(`Total pages: ${renderResult.totalPages}`);
    lines.push(`Rendered: ${renderResult.pages.length} page(s) [${pagesToRender[0]}${pagesToRender.length > 1 ? `–${pagesToRender[pagesToRender.length - 1]}` : ""}]`);
    lines.push(`Backend: ${renderResult.backend} (${dpi} DPI)`);
    lines.push("");

    for (const page of renderResult.pages) {
      lines.push(`[File: ${page.pngPath}]`);
      lines.push(`Page ${page.pageNumber} of ${renderResult.totalPages}`);
      if (page.width && page.height) {
        lines.push(`Dimensions: ${page.width}×${page.height}px`);
      }
      lines.push("");
    }

    if (pagesToRender[pagesToRender.length - 1] < totalPages) {
      const nextPage = pagesToRender[pagesToRender.length - 1] + 1;
      lines.push(`--- More pages available. Call pdf_read again with pages: "${nextPage}-${Math.min(nextPage + maxPages - 1, totalPages)}" to continue. ---`);
    }

    return lines.join("\n");
  },
};
