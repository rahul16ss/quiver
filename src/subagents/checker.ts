/**
 * Maker-Checker automated verification — EPIC 15.
 *
 * The maker (the agent) cannot self-certify its own work. This module is the
 * structurally isolated CHECKER: it runs in a separate sandboxed context with
 * read-only workspace access and no write/network/secret/full-env access, and
 * verifies work against the blueprint's acceptance criteria — emitting a
 * structured approve | reject | revise verdict with evidence.
 *
 * ONE COHERENT PATH (2026-07-30 revision):
 * The checker no longer branches on workspace type (code vs non-code vs
 * fallback). Instead it gathers ALL available evidence — deterministic checks
 * (npm tests if they exist, structural file checks, evidence validation,
 * benchmark bar-comparison) — and feeds them to a model-based evaluator that
 * reads the deliverable and returns a single approve/revise/reject verdict.
 *
 * The checker model is configurable via CHECKER_LLM_MODEL_NAME (falls back to
 * the primary LLM_MODEL_NAME). This lets you run a stronger/different model
 * for verification than for drafting — the "never let the builder grade itself"
 * principle, enforced at the model level.
 *
 * US-15.1 module + verdict, US-15.2 sandbox separation, US-15.3 spec-aware,
 * US-15.4 audit + override.
 */

import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { AuditChain } from "../logger.js";
import { buildScratchpad } from "./scratchpad_helpers.js";
import { classifyCommand } from "../security/command_policy.js";
import {
  resolveTargetedChecks,
  serializeCheckFilter,
} from "./checker_filter.js";
import { validateEvidenceFile } from "../evidence/tracker.js";
import { compare as compareBenchmark } from "../document/bar_critic.js";
import { config } from "../config.js";
import { createIsolatedEnv, spawnIsolatedProcess } from "./isolation.js";

// ─── Evidence validation (US-17.13 / SPEC §9.3 / §16) ──────────────────
// The checker must reject a document whose Evidence.json contains unsourced
// quantitative claims. This is the "every number traceable to a source" DoD.
// When the tool being checked is an office_doc write, we look for an
// Evidence.json alongside the document and validate it via the shared strict
// evidence reader.

export async function validateEvidenceForDocument(
  filePath: string,
): Promise<{ valid: boolean; problems: string[]; evidencePath: string | null }> {
  if (!filePath) {
    return {
      valid: false,
      problems: ["Office deliverable path is missing; evidence cannot be resolved"],
      evidencePath: null,
    };
  }

  const result = await validateEvidenceFile(filePath);
  if (result.missing && !config.evidenceRequired) {
    return {
      valid: true,
      problems: [],
      evidencePath: result.evidencePath,
    };
  }
  return {
    valid: result.valid,
    problems: result.problems,
    evidencePath: result.evidencePath,
  };
}

// ─── Sandbox separation (US-15.2) ─────────────────────────────────────
// The checker runs read-only: it may inspect the workspace but never mutate
// it, has no network access (it cannot exfiltrate or pull), and is denied
// the full process.env / secret surface (only non-secret metadata is visible).
export const CHECKER_SANDBOX = {
  readOnly: true, // noWrite: checker never writes workspace files
  noWrite: true,
  noNetwork: true, // network disabled — no outbound calls
  denyNetwork: true,
  noEnv: true, // full process.env is forbidden / redacted
  denyEnv: true,
  allowWrite: false,
  allowNetwork: false,
};

// ─── Copy-on-write scratchpad (US-15.2/15.3, per US-5.3) ──────────────
// The checker must NOT run against the real workspace cwd — it executes
// tests against an isolated copy-on-write scratchpad so it can never
// mutate the user's project. We create a temp directory, copy the
// essential project files (src/, tests/, package.json, tsconfig.json,
// node_modules symlink), and run the spawn there.

export type CheckerVerdict = "approve" | "reject" | "revise";

export interface CheckerResult {
  verdict: CheckerVerdict;
  changeHash: string;
  passed: number;
  failed: number;
  total: number;
  failedChecks: string[];
  evidence: string;
  timestamp: string;
}

// ─── Workspace type detection ─────────────────────────────────────────
// The checker must work for ALL workspaces, not just code projects.
// If tests/run_tests.ts exists → code project (run acceptance tests).
// If .quiver/acceptance.md exists → non-code workspace (run structural checks).
// Otherwise → fallback (basic file validation).

type WorkspaceType = "code" | "acceptance-md" | "fallback";

async function detectWorkspaceType(
  workspaceRoot: string,
): Promise<WorkspaceType> {
  try {
    await fs.access(path.join(workspaceRoot, "tests", "run_tests.ts"));
    return "code";
  } catch {
    /* not a code project */
  }
  try {
    await fs.access(path.join(workspaceRoot, ".quiver", "acceptance.md"));
    return "acceptance-md";
  } catch {
    /* no acceptance.md */
  }
  return "fallback";
}

// ─── Structural checks for non-code workspaces ────────────────────────
// Deterministic checks that don't require a test framework. These validate
// basic file integrity: exists, non-empty, valid UTF-8, no obvious secrets,
// no placeholder text.

interface StructuralCheck {
  id: string;
  description: string;
  fn: (
    workspaceRoot: string,
    toolName?: string,
    toolArgs?: any,
  ) => Promise<boolean>;
}

const STRUCTURAL_CHECKS: StructuralCheck[] = [
  {
    id: "FILE-EXISTS",
    description: "written file must exist on disk",
    fn: async (_root, toolName, toolArgs) => {
      if (!toolName || !toolArgs) return true;
      const filePath = toolArgs?.filePath || toolArgs?.path || "";
      if (!filePath) return true;
      try {
        await fs.access(path.resolve(filePath));
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    id: "FILE-NON-EMPTY",
    description: "written file must not be empty",
    fn: async (_root, toolName, toolArgs) => {
      if (!toolName || !toolArgs) return true;
      const filePath = toolArgs?.filePath || toolArgs?.path || "";
      if (!filePath) return true;
      if (toolName === "write_file") {
        const content = toolArgs?.content || "";
        return content.trim().length > 0;
      }
      return true;
    },
  },
  {
    id: "FILE-VALID-ENCODING",
    description: "written file must be valid UTF-8",
    fn: async (_root, toolName, toolArgs) => {
      if (!toolName || !toolArgs) return true;
      const filePath = toolArgs?.filePath || toolArgs?.path || "";
      if (!filePath) return true;
      try {
        const content = await fs.readFile(path.resolve(filePath), "utf8");
        return !content.includes("\ufffd"); // replacement char = bad encoding
      } catch {
        return false; // unable to verify encoding is a checker failure
      }
    },
  },
  {
    id: "FILE-NO-PLACEHOLDERS",
    description:
      "written file must not contain TODO/FIXME/XXX/PLACEHOLDER markers",
    fn: async (_root, toolName, toolArgs) => {
      if (!toolName || !toolArgs) return true;
      if (toolName !== "write_file") return true;
      const content = toolArgs?.content || "";
      if (!content) return true;
      const placeholders = /\b(TODO|FIXME|XXX|PLACEHOLDER|lorem ipsum)\b/i;
      return !placeholders.test(content);
    },
  },
];

// ─── Acceptance.md parser ─────────────────────────────────────────────
// Parses a .quiver/acceptance.md file with structured checklist criteria.
// Format:
//   ## Section Name
//   - [ ] criterion description
//   - [x] criterion description (already met)
//
// The checker evaluates each unchecked criterion against the workspace.

interface AcceptanceCriterion {
  id: string;
  description: string;
  section: string;
}

async function parseAcceptanceMd(
  workspaceRoot: string,
): Promise<AcceptanceCriterion[]> {
  const content = await fs.readFile(
    path.join(workspaceRoot, ".quiver", "acceptance.md"),
    "utf8",
  );
  const criteria: AcceptanceCriterion[] = [];
  let currentSection = "General";
  let counter = 0;

  for (const line of content.split("\n")) {
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }
    const criterionMatch = line.match(/^-\s+\[\s*\]\s+(.+)/);
    if (criterionMatch) {
      counter++;
      criteria.push({
        id: `ACCEPT-${counter}`,
        description: criterionMatch[1].trim(),
        section: currentSection,
      });
    }
  }

  return criteria;
}

async function runAcceptanceMdChecks(
  workspaceRoot: string,
  toolName?: string,
  toolArgs?: any,
): Promise<{
  passed: number;
  failed: number;
  total: number;
  failedChecks: string[];
}> {
  const criteria = await parseAcceptanceMd(workspaceRoot);
  const failedChecks: string[] = [];
  let passed = 0;
  let failed = 0;

  for (const criterion of criteria) {
    // Run structural checks as a baseline
    let met = true;
    for (const check of STRUCTURAL_CHECKS) {
      try {
        const ok = await check.fn(workspaceRoot, toolName, toolArgs);
        if (!ok) {
          met = false;
          break;
        }
      } catch {
        met = false;
        break;
      }
    }
    if (met) {
      passed++;
    } else {
      failed++;
      failedChecks.push(`${criterion.section}/${criterion.id}`);
    }
  }

  return { passed, failed, total: criteria.length, failedChecks };
}

async function runFallbackChecks(
  workspaceRoot: string,
  toolName?: string,
  toolArgs?: any,
): Promise<{
  passed: number;
  failed: number;
  total: number;
  failedChecks: string[];
}> {
  const failedChecks: string[] = [];
  let passed = 0;
  let failed = 0;

  for (const check of STRUCTURAL_CHECKS) {
    try {
      const ok = await check.fn(workspaceRoot, toolName, toolArgs);
      if (ok) {
        passed++;
      } else {
        failed++;
        failedChecks.push(check.id);
      }
    } catch {
      failed++;
      failedChecks.push(check.id);
    }
  }

  return { passed, failed, total: STRUCTURAL_CHECKS.length, failedChecks };
}

/**
 * Run the checker — ONE coherent path that gathers all available evidence
 * and feeds it to a model-based evaluator.
 *
 * Evidence sources (gathered in order, all optional):
 *   1. Deterministic checks: npm test suite (if tests/run_tests.ts exists),
 *      structural file checks (always), evidence validation (for office_doc),
 *      benchmark bar-comparison (if .quiver/benchmark/ configured).
 *   2. Optional model-based evaluation: only an explicitly configured checker
 *      endpoint may read the deliverable. Remote evaluation additionally
 *      requires QUIVER_CHECKER_REMOTE_APPROVED=1; otherwise it is a visible
 *      verification failure rather than a silent fallback.
 *
 * The verdict logic:
 *   - If deterministic checks fail → revise (the model confirms)
 *   - If deterministic checks pass but the model finds gaps → revise
 *   - If both pass → approve
 *   - If the checker can't run at all → reject (catastrophic failure)
 *
 * The checker model is configurable via CHECKER_LLM_MODEL_NAME and
 * CHECKER_LLM_API_BASE_URL. It is never implicitly sent to the maker's
 * endpoint: a missing or blocked checker route is not approval.
 */
export async function runChecker(
  changeHash: string,
  workspaceRoot: string = process.cwd(),
  toolName?: string,
  toolArgs?: any,
): Promise<CheckerResult> {
  const timestamp = new Date().toISOString();
  const failedChecks: string[] = [];
  let passed = 0;
  let failed = 0;
  let total = 0;

  // Sandbox constraints (US-15.2): read-only, no network, no env, no write.
  // These shape the test-suite spawn env (runAcceptanceTestSuite). Model
  // evaluation is separately gated below so the checker cannot create a
  // hidden outbound path around the harness.
  const sandbox = CHECKER_SANDBOX;
  // Enforce sandbox: the test suite spawn gets readOnly/noNetwork/noEnv.
  const _sandboxReadOnly = sandbox.readOnly;
  const _sandboxNoNetwork = sandbox.noNetwork;
  const _sandboxNoEnv = sandbox.noEnv;
  const targeted =
    toolName && toolArgs ? resolveTargetedChecks(toolName, toolArgs) : null;

  // ── Step 1: Gather deterministic evidence ──────────────────────────

  const evidence: string[] = [];

  // 1a. Run npm test suite if it exists (code projects)
  const hasTestSuite = await fileExists(path.join(workspaceRoot, "tests", "run_tests.ts"));
  let testResults: { ran: boolean; passed: number; failed: number; total: number; failedChecks: string[] } = {
    ran: false, passed: 0, failed: 0, total: 0, failedChecks: [],
  };

  if (hasTestSuite) {
    testResults = await runAcceptanceTestSuite(workspaceRoot, sandbox, targeted);
    if (testResults.ran) {
      passed += testResults.passed;
      failed += testResults.failed;
      total += testResults.total;
      failedChecks.push(...testResults.failedChecks);
      evidence.push(`Acceptance tests: ${testResults.passed}/${testResults.total} passed${testResults.failedChecks.length ? ` (failed: ${testResults.failedChecks.join(", ")})` : ""}.`);
    } else {
      failed++;
      total++;
      failedChecks.push("CHECKER-ACCEPTANCE-INFRASTRUCTURE");
      evidence.push("Acceptance tests: could not run (infrastructure failure).");
    }
  }

  // 1b. Run structural checks (always — for any workspace type)
  const structResult = await runStructuralChecks(workspaceRoot, toolName, toolArgs);
  if (structResult.total > 0) {
    passed += structResult.passed;
    failed += structResult.failed;
    total += structResult.total;
    failedChecks.push(...structResult.failedChecks);
    evidence.push(`Structural checks: ${structResult.passed}/${structResult.total} passed${structResult.failedChecks.length ? ` (failed: ${structResult.failedChecks.join(", ")})` : ""}.`);
  }

  // 1c. Evidence validation (for office_doc writes)
  if (toolName === "office_doc" && toolArgs?.file) {
    const docPath = String(toolArgs.file);
    const evResult = await validateEvidenceForDocument(docPath);
    if (!evResult.valid) {
      failedChecks.push(...evResult.problems.map((p) => `EVIDENCE/${p}`));
      failed += evResult.problems.length;
      total += evResult.problems.length;
      evidence.push(`Evidence validation: ${evResult.problems.length} problem(s) — ${evResult.problems.join("; ")}.`);
    } else {
      evidence.push("Evidence validation: all claims sourced or flagged.");
    }
  }

  // 1d. Benchmark bar-comparison (if configured) — folded into the same verdict
  let barGaps: string[] = [];
  if (toolName === "office_doc" && toolArgs?.file) {
    const docPath = String(toolArgs.file);
    try {
      const barResult = await compareBenchmark(docPath, workspaceRoot);
      if (barResult.ran && !barResult.met) {
        barGaps = barResult.gaps;
        failedChecks.push(...barGaps);
        failed += barGaps.length;
        total += barGaps.length;
        evidence.push(`Bar comparison: ${barGaps.length} gap(s) — ${barResult.biggestGap}.`);
      } else if (barResult.ran && barResult.met) {
        evidence.push("Bar comparison: met (draft compares favourably with benchmark).");
      }
    } catch (err: any) {
      const failure = "BAR-CHECKER-INFRASTRUCTURE";
      barGaps = [failure];
      failedChecks.push(failure);
      failed++;
      total++;
      evidence.push(
        `Bar comparison: failed to run (${err?.message || String(err)}).`,
      );
    }
  }

  // ── Step 2: Optional model-based evaluation ─────────────────────────
  // A checker model is a separate outbound data path. It is allowed only
  // when a dedicated endpoint is configured and the route is explicitly
  // approved. If that configured route fails, approval is impossible.

  let modelVerdict: CheckerVerdict | null = null;
  let modelReasoning = "";

  const checkerModel = config.checkerModelName;
  const checkerBaseUrl = config.checkerBaseUrl;
  const checkerApiKey = config.llmApiKey;
  const checkerConfigured = Boolean(checkerModel && checkerBaseUrl);
  const checkerRemoteApproved = process.env.QUIVER_CHECKER_REMOTE_APPROVED === "1";
  let checkerModelUnavailable = false;
  let checkerIsLocal = false;
  try {
    const hostname = new URL(checkerBaseUrl || "").hostname.toLowerCase();
    checkerIsLocal =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
  } catch {
    // Invalid endpoint is reported as a checker failure below.
  }

  if (checkerConfigured && (checkerIsLocal || checkerRemoteApproved)) {
    try {
      const deliverablePath = toolArgs?.file || toolArgs?.filePath || "";
      const deliverableContent = deliverablePath ? await readDeliverable(deliverablePath) : "";
      const modelResult = await runModelEvaluation({
        model: checkerModel,
        baseUrl: checkerBaseUrl,
        apiKey: checkerApiKey,
        evidence,
        deliverablePath,
        deliverableContent,
        toolName,
        toolArgs,
      });
      modelVerdict = modelResult.verdict;
      modelReasoning = modelResult.reasoning;
      evidence.push(`Checker model (${checkerModel}): ${modelVerdict} — ${modelReasoning}`);
    } catch (err: any) {
      checkerModelUnavailable = true;
      evidence.push(`Checker model: evaluation failed (${err.message}) — approval blocked.`);
    }
  } else if (checkerConfigured) {
    checkerModelUnavailable = true;
    evidence.push(
      checkerIsLocal
        ? "Checker model: configuration is invalid — approval blocked."
        : "Checker model: remote evaluation is not explicitly approved (set QUIVER_CHECKER_REMOTE_APPROVED=1) — approval blocked.",
    );
  } else {
    evidence.push("Checker model: not configured — deterministic checks are the complete checker.");
  }

  // ── Step 3: Compute the final verdict ───────────────────────────────
  // The deterministic results and the model verdict must agree for approve.
  // If either says revise/reject, the final verdict is revise/reject.

  const deterministicVerdict: CheckerVerdict =
    total > 0 && failed === 0 ? "approve" :
    total > 0 && failed > 0 ? "revise" :
    "reject" as CheckerVerdict; // no deterministic checks ran → not verified

  let verdict: CheckerVerdict;
  if (modelVerdict) {
    if (deterministicVerdict === "approve" && modelVerdict === "approve") {
      verdict = "approve";
    } else if (modelVerdict === "reject") {
      verdict = "reject";
    } else {
      verdict = "revise";
    }
  } else if (checkerModelUnavailable) {
    verdict = "reject";
  } else {
    verdict = deterministicVerdict;
  }

  const result: CheckerResult = {
    verdict,
    changeHash,
    passed,
    failed,
    total,
    failedChecks,
    evidence: evidence.join("\n"),
    timestamp,
  };

  await logCheckerVerdict(result);
  return result;
}

// ─── Helper: file exists ──────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

// ─── Helper: read deliverable content (truncated) ──────────────────────

async function readDeliverable(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.length > 8000 ? content.substring(0, 8000) + "\n[truncated]" : content;
  } catch {
    return "[file could not be read]";
  }
}

// ─── Helper: run acceptance test suite in scratchpad ───────────────────

async function runAcceptanceTestSuite(
  workspaceRoot: string,
  sandbox: typeof CHECKER_SANDBOX,
  targeted: ReturnType<typeof resolveTargetedChecks> | null,
): Promise<{ ran: boolean; passed: number; failed: number; total: number; failedChecks: string[] }> {
  const scratchDir = await buildScratchpad(workspaceRoot);
  // Ensure templates/ is present
  try {
    await fs.access(path.join(scratchDir, "templates"));
  } catch {
    try { await fs.cp(path.join(workspaceRoot, "templates"), path.join(scratchDir, "templates"), { recursive: true }); } catch {}
  }

  const childEnv = createIsolatedEnv(
    ["PATH", "USER", "LANG", "TERM"],
    {
      scratchDir,
      protectedDir: workspaceRoot,
      overrides: {
        LANG: process.env.LANG || "en_US.UTF-8",
        TERM: process.env.TERM || "dumb",
        QUIVER_NO_COLOR: "1",
      },
    },
  );
  if (config.checkerModelName) childEnv["CHECKER_LLM_MODEL_NAME"] = config.checkerModelName;
  if (config.checkerBaseUrl) childEnv["CHECKER_LLM_API_BASE_URL"] = config.checkerBaseUrl;
  if (sandbox.noEnv) childEnv["QUIVER_CHECKER_NO_ENV"] = "1";
  if (sandbox.noNetwork) childEnv["NO_NETWORK"] = "1";
  if (sandbox.readOnly) childEnv["QUIVER_CHECKER_READ_ONLY"] = "1";
  if (targeted && !targeted.full && targeted.checkIds.length > 0) {
    childEnv["QUIVER_CHECKER_FILTER"] = serializeCheckFilter(targeted.checkIds);
  }

  const testPath = path.join(scratchDir, "tests", "run_tests.ts");
  const workspaceBin = path.join(scratchDir, "node_modules", ".bin");
  const enhancedEnv = {
    ...childEnv,
    PATH: `${workspaceBin}${path.delimiter}${childEnv.PATH || ""}`,
  };

  try {
    const out = await new Promise<string>((resolve) => {
      let buf = "";
      const child = spawnIsolatedProcess("npx", ["tsx", testPath], {
        cwd: scratchDir,
        env: enhancedEnv,
      });
      child.stdout?.on("data", (d) => (buf += d.toString()));
      child.stderr?.on("data", (d) => (buf += d.toString()));
      child.on("exit", () => resolve(buf));
      child.on("error", () => resolve(buf));
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(buf); }, 180000);
    });

    const failMatch = out.match(/(\d+)\/(\d+)\s+(?:targeted\s+)?spec\s+acceptance\s+checks\s+FAILED/);
    const passMatch = out.match(/All\s+(\d+)\s+(?:targeted\s+)?spec\s+acceptance\s+checks\s+met/);
    if (passMatch) {
      const total = parseInt(passMatch[1], 10);
      return { ran: true, passed: total, failed: 0, total, failedChecks: [] };
    } else if (failMatch) {
      const failed = parseInt(failMatch[1], 10);
      const total = parseInt(failMatch[2], 10);
      const failedChecks: string[] = [];
      for (const m of out.matchAll(/•\s+\[([^\]]+)\]\s+(US-[0-9.]+|[A-Za-z-]+)/g)) {
        failedChecks.push(`${m[2]}/${m[1]}`);
      }
      return { ran: true, passed: total - failed, failed, total, failedChecks };
    }
    return {
      ran: false,
      passed: 0,
      failed: 1,
      total: 1,
      failedChecks: ["CHECKER-ACCEPTANCE-INFRASTRUCTURE"],
    };
  } catch {
    return {
      ran: false,
      passed: 0,
      failed: 1,
      total: 1,
      failedChecks: ["CHECKER-ACCEPTANCE-INFRASTRUCTURE"],
    };
  }
}

// ─── Helper: run structural checks ────────────────────────────────────

async function runStructuralChecks(
  workspaceRoot: string,
  toolName?: string,
  toolArgs?: any,
): Promise<{ passed: number; failed: number; total: number; failedChecks: string[] }> {
  // Check if there's an acceptance.md for criteria
  const hasAcceptanceMd = await fileExists(path.join(workspaceRoot, ".quiver", "acceptance.md"));
  if (hasAcceptanceMd) {
    try {
      return await runAcceptanceMdChecks(workspaceRoot, toolName, toolArgs);
    } catch {
      return {
        passed: 0,
        failed: 1,
        total: 1,
        failedChecks: ["CHECKER-STRUCTURAL-INFRASTRUCTURE"],
      };
    }
  }
  // Fallback structural checks
  try {
    return await runFallbackChecks(workspaceRoot, toolName, toolArgs);
  } catch {
    return {
      passed: 0,
      failed: 1,
      total: 1,
      failedChecks: ["CHECKER-STRUCTURAL-INFRASTRUCTURE"],
    };
  }
}

// ─── Model-based evaluation ──────────────────────────────────────────

interface ModelEvalInput {
  model: string;
  baseUrl: string;
  apiKey: string;
  evidence: string[];
  deliverablePath: string;
  deliverableContent: string;
  toolName?: string;
  toolArgs?: any;
}

async function runModelEvaluation(input: ModelEvalInput): Promise<{ verdict: CheckerVerdict; reasoning: string }> {
  const systemPrompt =
    `You are the VP CHECKER — a structurally isolated verifier that independently evaluates the Associate (maker)'s work. ` +
    `You never certify your own work and you never treat a saved file as final by itself.\n\n` +
    `Return a JSON object with exactly two fields:\n` +
    `  "verdict": "approve" | "revise" | "reject"\n` +
    `  "reasoning": a concise explanation (1-3 sentences) of why\n\n` +
    `Rules:\n` +
    `  - "approve": every applicable deterministic check passed, the deliverable is materially complete, and evidence supports its claims.\n` +
    `  - "revise": there are fixable gaps — identify the smallest useful correction.\n` +
    `  - "reject": the deliverable is fundamentally broken, unsafe, missing required evidence, or the verification gate could not run.\n` +
    `  - If deterministic checks failed, an evidence file is absent/invalid, a check is unsupported, or the result is empty, return "revise" or "reject"; never approve.\n` +
    `  - Inspect the actual deliverable and the supplied evidence. Do not invent a source, test result, or approval.\n` +
    `  - Be demanding but specific: the checker should help the maker fix the root cause, not rubber-stamp it.\n`;

  const userPrompt =
    `Tool that produced this work: ${input.toolName || "unknown"}\n` +
    `Deliverable path: ${input.deliverablePath || "n/a"}\n\n` +
    `Deterministic evidence:\n${input.evidence.map((e) => `  - ${e}`).join("\n")}\n\n` +
    `Deliverable content (truncated):\n${input.deliverableContent || "[no file content]"}\n\n` +
    `Evaluate this work for correctness, source traceability, uncertainty disclosure, and professional usability. ` +
    `Return JSON: {"verdict": "...", "reasoning": "..."}`;

  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Checker model API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Checker model did not return JSON");
  }
  const parsed = JSON.parse(jsonMatch[0]);
  const verdict = (["approve", "revise", "reject"].includes(parsed.verdict) ? parsed.verdict : "revise") as CheckerVerdict;
  const reasoning = String(parsed.reasoning || "No reasoning provided").substring(0, 500);
  return { verdict, reasoning };
}

// ─── Audit + override (US-15.4) ───────────────────────────────────────

const CHECKER_AUDIT_FILE = path.join(
  os.homedir(),
  ".quiver",
  "checker_audit.json",
);

async function logCheckerVerdict(result: CheckerResult): Promise<void> {
  try {
    let chain: AuditChain;
    try {
      const raw = await fs.readFile(CHECKER_AUDIT_FILE, "utf8");
      chain = AuditChain.deserialize(raw);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      chain = new AuditChain();
    }
    chain.appendEntry(
      "approval",
      `checker verdict=${result.verdict} changeHash=${result.changeHash} ${result.evidence}`,
    );
    await fs.mkdir(path.dirname(CHECKER_AUDIT_FILE), { recursive: true });
    await fs.writeFile(CHECKER_AUDIT_FILE, chain.serialize(), "utf8");
  } catch (error: any) {
    throw new Error(
      `Checker verdict could not be persisted to the audit chain: ${error?.message || String(error)}`,
    );
  }
}

/**
 * User override of a reject/revise verdict (US-15.4). Requires an explicit
 * confirmation string tied to the change hash; the override is appended to the
 * tamper-evident audit chain so the maker can proceed only with a logged
 * human-in-the-loop confirmation.
 */
export async function overrideVerdict(
  changeHash: string,
  userConfirmation: string,
): Promise<{ overridden: boolean; reason: string }> {
  if (!userConfirmation || userConfirmation.trim().length < 3) {
    return {
      overridden: false,
      reason: "override requires an explicit user confirmation",
    };
  }
  if (!changeHash || changeHash.trim().length < 3) {
    return {
      overridden: false,
      reason: "override must be tied to a change hash",
    };
  }
  try {
    let chain: AuditChain;
    try {
      const raw = await fs.readFile(CHECKER_AUDIT_FILE, "utf8");
      chain = AuditChain.deserialize(raw);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      chain = new AuditChain();
    }
    chain.appendEntry(
      "approval",
      `user OVERRIDE changeHash=${changeHash} confirmation="${userConfirmation.slice(0, 80)}" — reject/revise overruled by explicit logged confirmation`,
    );
    await fs.mkdir(path.dirname(CHECKER_AUDIT_FILE), { recursive: true });
    await fs.writeFile(CHECKER_AUDIT_FILE, chain.serialize(), "utf8");
  } catch (error: any) {
    return {
      overridden: false,
      reason: `override was not logged: ${error?.message || String(error)}`,
    };
  }
  return {
    overridden: true,
    reason: `override logged for change ${changeHash}`,
  };
}

/**
 * Convenience: classify whether a tool call is high-risk and so requires the
 * checker gate before commit (US-15.1 wrap_tool_call lifecycle hook).
 *
 * For run_command, uses the command classifier (US-6.2) to determine the
 * risk band — only destructive, privileged, secret-risk, and exfiltration-risk
 * commands trigger the checker. Safe commands like `echo` or `ls` do not.
 */
export function isHighRisk(toolName: string, toolArgs?: any): boolean {
  // File-writing tools always require checker verification
  if (["write_file", "replace_content", "apply_patch"].includes(toolName)) {
    return true;
  }

  // Office mutations are deliverable-producing actions. The checker must
  // verify the companion evidence package before the operation is accepted;
  // read-only Office views remain available without this gate.
  if (toolName === "office_doc") {
    const action = String(toolArgs?.action || "");
    return !["get", "view", "query", "validate", "help", "close"].includes(action);
  }

  // For run_command, classify the actual command string
  if (toolName === "run_command") {
    const commandStr: string =
      typeof toolArgs?.command === "string" ? toolArgs.command : "";
    if (!commandStr) return true;

    const classification = classifyCommand(commandStr);

    return (
      classification.risk === "destructive" ||
      classification.risk === "privileged" ||
      classification.risk === "secret-risk" ||
      classification.risk === "exfiltration-risk"
    );
  }

  return false;
}
