import { execFile } from "child_process";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";
import { findBinary } from "../utils/find_binary.js";

// ─── Types ───────────────────────────────────────────────────────────

interface OfficeCliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  json?: any;
}

// ─── Binary Discovery ────────────────────────────────────────────────

let officeCliPath: string | null | undefined;

async function findOfficeCli(): Promise<string | null> {
  if (officeCliPath !== undefined) return officeCliPath;
  const configured = process.env.QUIVER_OFFICECLI_PATH?.trim();
  if (configured) {
    officeCliPath = existsSync(configured) ? configured : findBinary(configured);
    return officeCliPath;
  }
  officeCliPath = findBinary("officecli");
  return officeCliPath;
}

// ─── Command Execution ───────────────────────────────────────────────

function runOfficeCli(
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<OfficeCliResult> {
  return new Promise(async (resolve) => {
    const binary = await findOfficeCli();
    if (!binary) {
      const installHint =
        process.platform === "win32"
          ? "Install the official Windows binary (PowerShell installer or Scoop): https://github.com/iOfficeAI/OfficeCLI"
          : "Install it with: curl -fsSL https://d.officecli.ai/install.sh | bash";
      resolve({
        success: false,
        stdout: "",
        stderr: `OfficeCLI is not installed. ${installHint} You can also set QUIVER_OFFICECLI_PATH.`,
        exitCode: 127,
      });
      return;
    }

    const maxBuffer = 1024 * 1024 * 10; // 10MB
    const maxAttempts = process.platform === "win32" ? 3 : 1;
    const lockPattern =
      /being used by another process|sharing violation|access is denied|file is locked/i;

    const attempt = (attemptNumber: number): void => {
      execFile(
        binary,
        args,
        {
          maxBuffer,
          cwd: cwd || process.cwd(),
          timeout: timeoutMs || 30000,
        },
        (error, stdout, stderr) => {
          const exitCode = error
            ? typeof error.code === "number"
              ? error.code
              : 1
            : 0;
          const result: OfficeCliResult = {
            success: exitCode === 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
          };

          // OneDrive/SharePoint sync can briefly hold a document lock.
          if (
            !result.success &&
            attemptNumber < maxAttempts &&
            lockPattern.test(`${result.stderr}\n${result.stdout}`)
          ) {
            setTimeout(() => attempt(attemptNumber + 1), 250 * attemptNumber);
            return;
          }

          // Try to parse JSON output if --json was passed
          if (args.includes("--json") && stdout) {
            try {
              result.json = JSON.parse(stdout);
            } catch {
              // Not JSON, leave as text
            }
          }

          resolve(result);
        },
      );
    };
    attempt(1);
  });
}

// ─── Path Validation ─────────────────────────────────────────────────

function validateFilePath(filePath: string): string | null {
  if (!filePath) return "File path is required.";
  const ext = path.extname(filePath).toLowerCase();
  if (![".docx", ".xlsx", ".pptx"].includes(ext)) {
    return `Unsupported file type: ${ext}. Only .docx, .xlsx, and .pptx are supported.`;
  }
  return null;
}

// ─── Tool Definition ─────────────────────────────────────────────────

export const tool: Tool = {
  name: "office_doc",
  description:
    "Create, edit, view, and manage Office documents (.docx, .xlsx, .pptx) using the OfficeCLI engine. " +
    "Supports creating blank documents, adding elements (paragraphs, tables, slides, cells, shapes, comments), " +
    "modifying properties, viewing content, batch operations, and template merging. " +
    "No Microsoft Office installation required. Use this tool when the user needs Word, Excel, or PowerPoint documents.\n\n" +
    "For quantitative or source-backed deliverables, pair this tool with the evidence tool: register inputs and claims, " +
    "validate the evidence companion, and do not present the output as final before the review gates pass.\n\n" +
    "Key capabilities:\n" +
    "- Word comments: add comments to paragraphs/runs with `action: 'add', parent: '/body/p[1]', type: 'comment', props: {text: '...', author: '...'}`. " +
    "Query with `action: 'query', selector: 'comment'`. Get with `action: 'get', path: '/comments/comment[1]'`. " +
    "Set resolved with `action: 'set', path: '/comments/comment[1]', props: {done: 'true'}}`. " +
    "PowerPoint comments: `parent: '/slide[1]', type: 'comment'` with x/y coordinates.\n" +
    "- Excel range reading: `action: 'get', path: '/Sheet1/A1:D20'` returns all cells in the range with values, types, and formatting. " +
    "Use `action: 'view', mode: 'text'` with `props: {range: 'Sheet1!A1:D20'}` for a compact text view of a range.\n" +
    "- Excel formula reading: `action: 'get', path: '/Sheet1/B3', json: true` returns formula, cachedValue, computedValue, and evaluated fields for formula cells.\n" +
    "- Template merge: `action: 'merge', template: 'template.docx', file: 'output.docx', data: 'data.json'` replaces {{key}} placeholders. " +
    "Supports nested paths like {{items[0].name}} and {{company.revenue}}. Use `props: {force: 'true'}` to overwrite existing output.\n" +
    "- Use `action: 'help'` with `format: 'docx|xlsx|pptx'` and optional `element: 'comment|cell|range|paragraph'` to discover available properties.",
  parameters: z.object({
    action: z
      .enum([
        "create",
        "add",
        "set",
        "get",
        "view",
        "query",
        "remove",
        "move",
        "swap",
        "batch",
        "save",
        "close",
        "validate",
        "merge",
        "import",
        "help",
      ])
      .describe("The OfficeCLI operation to perform."),
    file: z
      .string()
      .describe(
        "Path to the Office document (.docx, .xlsx, or .pptx). Can be relative to cwd.",
      ),
    parent: z
      .string()
      .optional()
      .describe(
        "Parent path for add operations (e.g., /body, /slide[1], /Sheet1).",
      ),
    path: z
      .string()
      .optional()
      .describe(
        "Element path for set/get/remove/move operations (e.g., /body/p[1], /Sheet1/A1, /slide[1]/shape[2]).",
      ),
    type: z
      .string()
      .optional()
      .describe(
        "Element type for add operations (e.g., paragraph, table, slide, shape, cell, textbox, row, column).",
      ),
    props: z
      .record(z.string())
      .optional()
      .describe(
        'Properties as key-value pairs (e.g., { text: "Hello", style: "Heading1", bold: "true" }). Use string values for all props.',
      ),
    commands: z
      .array(z.record(z.any()))
      .optional()
      .describe(
        "Array of batch commands for the batch action. Each item has: command (verb), path, parent, type, props, etc.",
      ),
    mode: z
      .string()
      .optional()
      .describe(
        "View mode for view action: text, outline, stats, issues, annotated, html.",
      ),
    selector: z
      .string()
      .optional()
      .describe("CSS-like selector for query operations."),
    template: z
      .string()
      .optional()
      .describe("Template file path for merge action."),
    data: z
      .string()
      .optional()
      .describe(
        "JSON data file path for merge action (replaces {{key}} placeholders).",
      ),
    source: z
      .string()
      .optional()
      .describe("Source CSV/TSV file path for import action."),
    format: z
      .string()
      .optional()
      .describe("Format for help action: docx, xlsx, pptx, or all."),
    element: z
      .string()
      .optional()
      .describe(
        "Element name for help action (e.g., paragraph, table, slide).",
      ),
    json: z.boolean().optional().describe("Output results as JSON when true."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory. Defaults to current directory."),
    stage: z
      .boolean()
      .optional()
      .describe(
        "When true, operate on a staged working copy (ArtifactRepository) rather than the original — never mutate the source directly. Returns the staged copy path + source hash. Default false (legacy direct-write behavior).",
      ),
  }),

  execute: async (args: any) => {
    // Path-policy guard (US-9.2): reject sensitive paths.
    // Use "write" for mutating actions, "read" for read-only actions.
    // "validate" and "close" are read-only — they don't modify the file.
    const _writeActions = new Set([
      "create",
      "add",
      "set",
      "remove",
      "move",
      "swap",
      "batch",
      "save",
      "merge",
      "import",
    ]);
    const _operation = _writeActions.has(args.action) ? "write" : "read";
    let _resolvedFile: string | undefined;
    try {
      const _checkPath =
        args.file || args.filePath || args.directory || args.path || "";
      if (_checkPath) {
        const _resolved = assertToolPathAllowed(
          _checkPath,
          _operation as "read" | "write",
        );
        _resolvedFile = _resolved.absolutePath;
      }
      // Validate additional file paths (template, source) through the policy
      if (args.template) assertToolPathAllowed(args.template, "read");
      if (args.source) assertToolPathAllowed(args.source, "read");
      if (args.data) assertToolPathAllowed(args.data, "read");
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
    const {
      action,
      file: _rawFile,
      parent,
      path: elemPath,
      type,
      props,
      commands,
      mode,
      selector,
      template,
      data,
      source,
      format,
      element,
      json,
      cwd,
    } = args;

    // Use the resolved path (honors scratch-area redirect) if available;
    // otherwise fall back to the raw file argument.
    let file = _resolvedFile ?? _rawFile;
    // ── Staged working copy (ADR-005 / ADR-006): when stage=true and this is a
    //    write action, snapshot the source and operate on an isolated working
    //    copy so the original is never mutated directly. Additive: default
    //    (stage unset) is the legacy direct-write behavior.
    let stagedSourceHash: string | undefined;
    let staged = false;
    if (args.stage === true && _writeActions.has(action) && file) {
      try {
        const { LocalArtifactRepository } = await import("../harness/artifact-repository.js");
        const { createHash } = await import("crypto");
        const stagingRoot = path.join(args.cwd || process.cwd(), ".quiver", "office-staging");
        const repo = new LocalArtifactRepository(stagingRoot);
        const srcData = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
        const mime = extToMimeOffice(file);
        const stagedArt = await repo.stage(
          { identity: { id: file, path: file }, data: srcData, mimeType: mime, path: file },
          `office-${Date.now()}`,
        );
        stagedSourceHash = stagedArt.sourceHash;
        // Operate on the working copy for edits; for create/merge (new file),
        // write the output into the staging area alongside the snapshot.
        if (existsSync(file)) {
          file = stagedArt.workingCopyPath;
        } else {
          file = path.join(path.dirname(stagedArt.snapshotPath), path.basename(file));
        }
        staged = true;
      } catch (e: any) {
        return `Error: staging failed: ${e.message}`;
      }
    }

    // ─── Help action (no file needed) ────────────────────────────────
    if (action === "help") {
      const cliArgs: string[] = ["help"];
      if (format) cliArgs.push(format);
      if (element) cliArgs.push(element);
      if (json) cliArgs.push("--json");

      const result = await runOfficeCli(cliArgs, cwd);
      if (result.success) {
        return result.stdout || "No help output.";
      }
      return `Help failed: ${result.stderr || result.stdout}`;
    }

    // ─── Validate file path for all other actions ────────────────────
    const pathError = validateFilePath(file);
    if (pathError) return `Error: ${pathError}`;

    // Snapshot before mutating so maker-checker reject can rollbackLast().
    if (_writeActions.has(action) && file) {
      const { snapshotForRollback } = await import("../fs/atomic_write.js");
      await snapshotForRollback(file);
    }

    // OneDrive/SharePoint conflict copies are safer than an implicit
    // overwrite. On Windows, creating or merging over an existing deliverable
    // requires an explicit force property after the user has reviewed it.
    if (
      process.platform === "win32" &&
      (action === "create" || action === "merge") &&
      existsSync(file) &&
      props?.force !== "true"
    ) {
      return (
        `Error: refusing to overwrite existing Office file '${file}' on Windows. ` +
        "Review the existing deliverable and set props.force='true' to replace it."
      );
    }

    // ─── Build CLI args based on action ──────────────────────────────
    const cliArgs: string[] = [];
    const useJson = json !== false; // Default to JSON for structured output

    switch (action) {
      case "create":
        cliArgs.push("create", file);
        break;

      case "add":
        if (!parent) return "Error: 'parent' is required for add action.";
        if (!type) return "Error: 'type' is required for add action.";
        cliArgs.push("add", file, parent, "--type", type);
        if (props) {
          for (const [key, value] of Object.entries(props)) {
            cliArgs.push("--prop", `${key}=${String(value)}`);
          }
        }
        break;

      case "set":
        if (!elemPath) return "Error: 'path' is required for set action.";
        cliArgs.push("set", file, elemPath);
        if (props) {
          for (const [key, value] of Object.entries(props)) {
            cliArgs.push("--prop", `${key}=${String(value)}`);
          }
        }
        break;

      case "get":
        cliArgs.push("get", file, elemPath || "/");
        if (json) cliArgs.push("--json");
        // Allow deeper child traversal (default is 1)
        if (props?.depth) cliArgs.push("--depth", String(props.depth));
        break;

      case "view":
        cliArgs.push("view", file, mode || "text");
        // Excel range filter: pass --range for text mode on .xlsx files
        // Allows reading a compact slice of a large sheet (e.g. Sheet1!A1:D20)
        if (props?.range) cliArgs.push("--range", String(props.range));
        // Column filter for Excel text view
        if (props?.cols) cliArgs.push("--cols", String(props.cols));
        // Line/row limits
        if (props?.start) cliArgs.push("--start", String(props.start));
        if (props?.end) cliArgs.push("--end", String(props.end));
        if (props?.maxLines)
          cliArgs.push("--max-lines", String(props.maxLines));
        // Page filter for docx/pptx
        if (props?.page) cliArgs.push("--page", String(props.page));
        // Issue type filter for issues mode
        if (props?.type) cliArgs.push("--type", String(props.type));
        if (props?.limit) cliArgs.push("--limit", String(props.limit));
        break;

      case "query":
        if (!selector) return "Error: 'selector' is required for query action.";
        cliArgs.push("query", file, selector);
        if (json) cliArgs.push("--json");
        break;

      case "remove":
        if (!elemPath) return "Error: 'path' is required for remove action.";
        cliArgs.push("remove", file, elemPath);
        break;

      case "move":
        if (!elemPath) return "Error: 'path' is required for move action.";
        cliArgs.push("move", file, elemPath);
        if (props?.to) cliArgs.push("--to", String(props.to));
        if (props?.after) cliArgs.push("--after", String(props.after));
        if (props?.before) cliArgs.push("--before", String(props.before));
        if (props?.index !== undefined)
          cliArgs.push("--index", String(props.index));
        break;

      case "swap":
        if (!elemPath)
          return "Error: 'path' is required for swap action (first path).";
        if (!props?.path2)
          return "Error: 'props.path2' is required for swap action (second path).";
        cliArgs.push("swap", file, elemPath, String(props.path2));
        break;

      case "batch":
        if (!commands)
          return "Error: 'commands' array is required for batch action.";
        cliArgs.push("batch", file);
        if (useJson) cliArgs.push("--json");
        // Pass commands via --commands flag as JSON string
        cliArgs.push("--commands", JSON.stringify(commands));
        break;

      case "save":
        cliArgs.push("save", file);
        break;

      case "close":
        cliArgs.push("close", file);
        break;

      case "validate":
        cliArgs.push("validate", file);
        break;

      case "merge":
        if (!template) return "Error: 'template' is required for merge action.";
        if (!data)
          return "Error: 'data' (JSON data file path) is required for merge action.";
        // officecli merge <template> <output> --data <data.json>
        // Replaces {{key}} placeholders in the template with values from the JSON data file.
        // Supports nested paths like {{items[0].name}} and {{company.revenue}}.
        cliArgs.push("merge", template, file, "--data", data);
        // Allow overwriting existing output file
        if (props?.force === "true" || props?.force === true)
          cliArgs.push("--force");
        break;

      case "import":
        if (!parent)
          return "Error: 'parent' (parent-path) is required for import action.";
        if (!source)
          return "Error: 'source' (CSV/TSV file path) is required for import action.";
        cliArgs.push("import", file, parent, source);
        break;

      default:
        return `Error: Unknown action '${action}'.`;
    }

    const result = await runOfficeCli(cliArgs, cwd);

    // ─── Format output ───────────────────────────────────────────────
    if (result.success) {
      const stagedNote = staged
        ? `\n[staged] workingCopy=${file} sourceHash=${stagedSourceHash ?? ""}`
        : "";
      if (result.json) {
        return JSON.stringify({ ...result.json, ...(staged ? { staged: true, workingCopy: file, sourceHash: stagedSourceHash } : {}) }, null, 2);
      }
      return (result.stdout || "Operation completed successfully.") + stagedNote;
    }

    // Error case
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`STDERR: ${result.stderr}`);
    parts.push(`EXIT CODE: ${result.exitCode}`);
    return parts.join("\n\n");
  },
};

function extToMimeOffice(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

