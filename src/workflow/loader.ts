/**
 * Workflow Loader — parses workflow.yaml files into WorkflowDefinition objects.
 *
 * Uses a minimal hand-rolled YAML parser sufficient for the simple key-value
 * + list structure in workflow packs. Avoids adding a YAML library dependency.
 * Falls back to JSON if the file has a `.json` extension.
 *
 * SPEC §12 / §19 Build Order #7.
 */

import * as fs from "fs";
import * as path from "path";
import type { WorkflowDefinition, WorkflowFamily } from "./types.js";

// ─── Minimal YAML parser (key: value + lists only) ──────────────────

/**
 * Parse a simple YAML document into a nested object.
 *
 * Supports:
 *   - `key: value` pairs
 *   - `key: >` block scalars (folded)
 *   - `- item` lists
 *   - Nested objects (indentation-based, one level deep for our use case)
 *   - Comments (lines starting with `#`)
 */
function parseSimpleYaml(text: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // Determine indentation level
    const indent = line.length - line.trimStart().length;

    // Only parse top-level keys (indent === 0)
    if (indent > 0) {
      i++;
      continue;
    }

    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.substring(0, colonIdx).trim();
    const rawValue = trimmed.substring(colonIdx + 1).trim();

    if (rawValue === ">" || rawValue === "|") {
      // Block scalar: collect indented lines
      const blockLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine.trim()) {
          // Empty line within block — might be end or continuation
          if (i + 1 < lines.length && lines[i + 1].length - lines[i + 1].trimStart().length > 0) {
            blockLines.push("");
            i++;
            continue;
          }
          break;
        }
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        if (nextIndent === 0) break;
        blockLines.push(nextLine.trim());
        i++;
      }
      result[key] = rawValue === ">" ? blockLines.join(" ") : blockLines.join("\n");
    } else if (rawValue === "") {
      // Could be a nested object or a list — peek at next lines
      i++;
      const children: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (!nextLine.trim() || nextLine.trim().startsWith("#")) {
          i++;
          continue;
        }
        const nextIndent = nextLine.length - nextLine.trimStart().length;
        if (nextIndent === 0) break;
        children.push(nextLine);
        i++;
      }
      if (children.length > 0 && children[0].trim().startsWith("- ")) {
        // It's a list
        result[key] = children
          .filter((l) => l.trim().startsWith("- "))
          .map((l) => l.trim().substring(2).trim());
      } else {
        // It's a nested object
        const nested: Record<string, string> = {};
        for (const child of children) {
          const cTrimmed = child.trim();
          const cColon = cTrimmed.indexOf(":");
          if (cColon !== -1) {
            const cKey = cTrimmed.substring(0, cColon).trim();
            const cVal = cTrimmed.substring(cColon + 1).trim();
            nested[cKey] = cVal;
          }
        }
        result[key] = nested;
      }
    } else {
      // Simple key: value
      result[key] = rawValue;
      i++;
    }
  }

  return result;
}

// ─── Loader ────────────────────────────────────────────────────────────

/**
 * Load a single workflow definition from a workflow.yaml or workflow.json file.
 *
 * @param workflowFile - Absolute path to the workflow.yaml (or .json) file
 * @returns Parsed WorkflowDefinition
 */
export function loadWorkflow(workflowFile: string): WorkflowDefinition {
  const ext = path.extname(workflowFile);
  const packRoot = path.dirname(workflowFile);
  const raw = fs.readFileSync(workflowFile, "utf8");

  let parsed: Record<string, any>;
  if (ext === ".json") {
    parsed = JSON.parse(raw);
  } else {
    parsed = parseSimpleYaml(raw);
  }

  const maturity =
    parsed.maturity === "production" ||
    parsed.maturity === "beta" ||
    parsed.maturity === "demo-ready" ||
    parsed.maturity === "scaffold"
      ? parsed.maturity
      : "scaffold";

  const def: WorkflowDefinition = {
    name: parsed.name || path.basename(packRoot),
    family: (parsed.family || "dealmaking") as WorkflowFamily,
    version: parsed.version || "0.0.0",
    maturity,
    business_purpose: parsed.business_purpose || "",
    output_template: parsed.output_template,
    allowed_inputs: Array.isArray(parsed.allowed_inputs) ? parsed.allowed_inputs : [],
    retrieval: parsed.retrieval
      ? {
          mode: parsed.retrieval.mode || "static",
          network_access: parsed.retrieval.network_access || "none",
        }
      : undefined,
    data_sensitivity: parsed.data_sensitivity || "synthetic",
    deliverable_sections: Array.isArray(parsed.deliverable_sections)
      ? parsed.deliverable_sections
      : [],
    review_role: parsed.review_role,
    acceptance_checks: parsed.acceptance_checks,
    outputs: typeof parsed.outputs === "object" ? parsed.outputs : undefined,
    schedule: parsed.schedule
      ? { cron: parsed.schedule.cron, label: parsed.schedule.label }
      : undefined,
    watch: parsed.watch
      ? {
          directories: Array.isArray(parsed.watch.directories) ? parsed.watch.directories : [],
          patterns: Array.isArray(parsed.watch.patterns) ? parsed.watch.patterns : [],
          debounce_ms: parsed.watch.debounce_ms ? Number(parsed.watch.debounce_ms) : undefined,
        }
      : undefined,
    packRoot,
  };

  return def;
}

/**
 * Discover and load all workflow packs from the workflow-packs directory.
 *
 * Scans the standard `workflow-packs/<family>/<pack>/workflow.yaml` layout.
 *
 * @param packsDir - Root directory containing family subdirectories
 * @returns Array of loaded WorkflowDefinitions
 */
export function discoverWorkflows(packsDir: string): WorkflowDefinition[] {
  const workflows: WorkflowDefinition[] = [];

  if (!fs.existsSync(packsDir)) return workflows;

  // Scan family directories
  const families = fs.readdirSync(packsDir, { withFileTypes: true });
  for (const family of families) {
    if (!family.isDirectory()) continue;
    const familyDir = path.join(packsDir, family.name);

    // Scan pack directories within each family
    const packs = fs.readdirSync(familyDir, { withFileTypes: true });
    for (const pack of packs) {
      if (!pack.isDirectory()) continue;
      const packDir = path.join(familyDir, pack.name);

      // Look for workflow.yaml or workflow.json
      for (const filename of ["workflow.yaml", "workflow.yml", "workflow.json"]) {
        const workflowFile = path.join(packDir, filename);
        if (fs.existsSync(workflowFile)) {
          try {
            workflows.push(loadWorkflow(workflowFile));
          } catch (err) {
            console.error(`Failed to load workflow from ${workflowFile}:`, err);
          }
          break; // Only load the first found workflow file
        }
      }
    }
  }

  return workflows;
}

/**
 * Find and load a specific workflow by name.
 *
 * @param name - Workflow name to find (e.g., "investment-committee-memo")
 * @param packsDir - Root workflow-packs directory
 * @returns The matching WorkflowDefinition, or null if not found
 */
export function findWorkflow(name: string, packsDir: string): WorkflowDefinition | null {
  const all = discoverWorkflows(packsDir);
  return all.find((w) => w.name === name) || null;
}
