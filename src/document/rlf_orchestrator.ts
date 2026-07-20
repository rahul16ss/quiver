/**
 * Render→Look→Fix Orchestration — US-17.20 / Epic 9.
 *
 * Orchestrates the iterative document refinement loop:
 * 1. Render: Use OfficeCLI `view screenshot` to produce a PNG of the document
 * 2. Look: Feed the PNG to the vision model for layout/quality assessment
 * 3. Fix: The agent makes a surgical edit based on the vision feedback
 * 4. Repeat until validate + view issues pass (capped rounds)
 *
 * Each step is logged to the audit chain. The conversation history
 * becomes the render→look→fix history of the deliverable.
 *
 * SPEC §10: "Every render, look, and fix is one entry in the conversation
 * and audit chain."
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { findBinary } from "../utils/find_binary.js";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────

export interface RenderLookFixConfig {
  filePath: string;
  maxRounds: number;
  startPage: number;
  endPage: number;
  screenshotWidth: number;
  screenshotHeight: number;
}

export interface RlfStep {
  round: number;
  step: "render" | "look" | "fix";
  timestamp: string;
  details: string;
  success: boolean;
}

export interface RlfResult {
  rounds: number;
  steps: RlfStep[];
  passed: boolean;
  issues: string[];
  message: string;
}

// ─── Core functions ──────────────────────────────────────────────────

/**
 * Find the OfficeCLI binary.
 */
async function getOfficeCli(): Promise<string | null> {
  return findBinary("officecli");
}

/**
 * Run an OfficeCLI command and return stdout.
 */
async function runOfficeCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const bin = await getOfficeCli();
  if (!bin) throw new Error("OfficeCLI binary not found");

  const { stdout, stderr } = await execFileAsync(bin, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
  });
  return { stdout, stderr };
}

/**
 * Render a document to a screenshot PNG.
 * Returns the path to the temporary PNG file.
 */
export async function renderDocument(
  filePath: string,
  options: Partial<RenderLookFixConfig> = {},
): Promise<{ pngPath: string; step: RlfStep }> {
  const tmpDir = os.tmpdir();
  const pngPath = path.join(
    tmpDir,
    `quiver-render-${Date.now()}.png`,
  );

  const args = [
    "view",
    filePath,
    "screenshot",
    "-o",
    pngPath,
    "--screenshot-width",
    String(options.screenshotWidth || 1600),
    "--screenshot-height",
    String(options.screenshotHeight || 1200),
  ];

  if (options.startPage) {
    args.push("--page", String(options.startPage));
  }

  const step: RlfStep = {
    round: 0,
    step: "render",
    timestamp: new Date().toISOString(),
    details: `Rendered ${path.basename(filePath)} to PNG`,
    success: true,
  };

  try {
    await runOfficeCli(args);
    // Verify the PNG was created
    await fs.access(pngPath);
  } catch (err: any) {
    step.success = false;
    step.details = `Render failed: ${err.message}`;
    throw err;
  }

  return { pngPath, step };
}

/**
 * Check document validity and issues.
 * Returns the issues found and whether validation passed.
 */
export async function checkDocument(
  filePath: string,
): Promise<{ valid: boolean; issues: string[]; step: RlfStep }> {
  const issues: string[] = [];
  let valid = false;

  const step: RlfStep = {
    round: 0,
    step: "look",
    timestamp: new Date().toISOString(),
    details: "",
    success: true,
  };

  try {
    // Run validate
    const validateResult = await runOfficeCli(["validate", filePath, "--json"]);
    const validateData = JSON.parse(validateResult.stdout);
    valid = validateData.valid === true || validateData.valid === "true";

    // Run view issues
    const issuesResult = await runOfficeCli(["view", filePath, "issues", "--json"]);
    const issuesData = JSON.parse(issuesResult.stdout);

    if (Array.isArray(issuesData.issues)) {
      issues.push(...issuesData.issues.map((i: any) =>
        typeof i === "string" ? i : `${i.type || "issue"}: ${i.message || i.description || JSON.stringify(i)}`,
      ));
    } else if (issuesData.count && issuesData.count > 0) {
      issues.push(`${issuesData.count} issues found`);
    }

    step.details = `Validate: ${valid ? "pass" : "fail"}, Issues: ${issues.length}`;
  } catch (err: any) {
    step.success = false;
    step.details = `Check failed: ${err.message}`;
  }

  return { valid, issues, step };
}

/**
 * Orchestrate the full render→look→fix loop.
 *
 * This function:
 * 1. Renders the document to a PNG
 * 2. Checks validity and issues
 * 3. If issues found, returns them for the agent to fix
 * 4. The agent fixes, then calls this again for the next round
 *
 * The actual "fix" step is performed by the agent (via office_doc tool).
 * This function handles render + look. The agent handles fix.
 * The loop is: render → look → (agent fixes) → render → look → ...
 *
 * @param filePath Path to the Office document
 * @param round Current round number (1-based)
 * @param options Configuration
 * @returns Result with issues to fix and PNG path for vision inspection
 */
export async function renderLookFixCycle(
  filePath: string,
  round: number = 1,
  options: Partial<RenderLookFixConfig> = {},
): Promise<RlfResult & { pngPath?: string }> {
  const maxRounds = options.maxRounds || 5;
  const steps: RlfStep[] = [];

  if (round > maxRounds) {
    return {
      rounds: round - 1,
      steps,
      passed: false,
      issues: [`Max rounds (${maxRounds}) exceeded`],
      message: `Document refinement stopped after ${maxRounds} rounds. Issues may remain.`,
    };
  }

  // Step 1: Render
  let pngPath: string | undefined;
  try {
    const renderResult = await renderDocument(filePath, options);
    pngPath = renderResult.pngPath;
    renderResult.step.round = round;
    steps.push(renderResult.step);
  } catch {
    return {
      rounds: round,
      steps,
      passed: false,
      issues: ["Render failed"],
      message: "Failed to render document to PNG. Check OfficeCLI installation.",
    };
  }

  // Step 2: Look (validate + issues)
  const checkResult = await checkDocument(filePath);
  checkResult.step.round = round;
  steps.push(checkResult.step);

  const passed = checkResult.valid && checkResult.issues.length === 0;

  return {
    rounds: round,
    steps,
    passed,
    issues: checkResult.issues,
    message: passed
      ? `Document passed validation with no issues after round ${round}.`
      : `Round ${round}: ${checkResult.issues.length} issue(s) found. Review the screenshot and fix them.`,
    pngPath,
  };
}

/**
 * Format the RLF result for display to the user.
 */
export function formatRlfResult(result: RlfResult & { pngPath?: string }): string {
  const lines: string[] = [];
  lines.push(`Render→Look→Fix — Round ${result.rounds}`);
  lines.push("─".repeat(50));

  for (const step of result.steps) {
    const icon = step.success ? "✓" : "✗";
    lines.push(`  ${icon} [${step.step}] ${step.details}`);
  }

  lines.push("");
  if (result.passed) {
    lines.push("  ✓ Document passed validation.");
  } else {
    lines.push(`  ⚠ ${result.issues.length} issue(s):`);
    for (const issue of result.issues) {
      lines.push(`    • ${issue}`);
    }
  }

  if (result.pngPath) {
    lines.push("");
    lines.push(`  Screenshot: ${result.pngPath}`);
  }

  return lines.join("\n");
}