import { execFile } from "child_process";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js"
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
      resolve({
        success: false,
        stdout: "",
        stderr:
          "OfficeCLI is not installed. Install it with: curl -fsSL https://d.officecli.ai/install.sh | bash",
        exitCode: 127,
      });
      return;
    }

    
    const maxBuffer = 1024 * 1024 * 10; // 10MB

    execFile(
      binary,
      args,
      {
        maxBuffer,
        cwd: cwd || process.cwd(),
        timeout: timeoutMs || 30000,
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const result: OfficeCliResult = {
          success: exitCode === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode,
        };

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
    "Supports creating blank documents, adding elements (paragraphs, tables, slides, cells, shapes), " +
    "modifying properties, viewing content, batch operations, and template merging. " +
    "No Microsoft Office installation required. Use this tool when the user needs Word, Excel, or PowerPoint documents.",
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
  }),

  execute: async (args: any) => {
    // Path-policy guard (US-9.2): reject sensitive paths.
    // Use "write" for mutating actions, "read" for read-only actions.
    const _writeActions = new Set(["create", "add", "set", "remove", "move", "swap", "batch", "save", "merge", "import", "close", "validate"]);
    const _operation = _writeActions.has(args.action) ? "write" : "read";
    try {
      const _checkPath = args.file || args.filePath || args.directory || args.path || "";
      if (_checkPath) assertToolPathAllowed(_checkPath, _operation as "read" | "write");
      // Validate additional file paths (template, source) through the policy
      if (args.template) assertToolPathAllowed(args.template, "read");
      if (args.source) assertToolPathAllowed(args.source, "read");
      if (args.data) assertToolPathAllowed(args.data, "read");
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
    const {
      action,
      file,
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
        break;

      case "view":
        cliArgs.push("view", file, mode || "text");
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
        cliArgs.push("merge", template, file, "--data", data);
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
      if (result.json) {
        return JSON.stringify(result.json, null, 2);
      }
      return result.stdout || "Operation completed successfully.";
    }

    // Error case
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`STDERR: ${result.stderr}`);
    parts.push(`EXIT CODE: ${result.exitCode}`);
    return parts.join("\n\n");
  },
};
