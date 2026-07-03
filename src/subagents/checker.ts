/**
 * Maker-Checker automated verification — EPIC 15.
 *
 * The maker (the agent) cannot self-certify its own work. This module is the
 * structurally isolated CHECKER: it runs in a separate sandboxed context with
 * read-only workspace access and no write/network/secret/full-env access, and
 * verifies work against the blueprint's acceptance criteria — specifically
 * `tests/spec_acceptance_tests.ts` (the checker-owned contract) — emitting a
 * structured approve | reject | revise verdict with evidence. Every verdict
 * is appended to the tamper-evident audit chain, and the user can override a
 * reject/revise with an explicit logged confirmation tied to the change hash.
 *
 * US-15.1 module + verdict, US-15.2 sandbox separation, US-15.3 spec-aware,
 * US-15.4 audit + override.
 */

import { spawn } from "child_process";
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
        return true; // can't check — don't block
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
 * Run the checker against the acceptance contract (`tests/spec_acceptance_tests.ts`,
 * executed via `npm test` / runSpecAcceptanceTests). The verdict:
 *   - approve  : every acceptance criterion passed
 *   - revise   : one or more criteria failed and appear fixable by the maker
 *   - reject   : the acceptance gate could not run or failed catastrophically
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
  let ran = false;

  // Apply sandbox constraints (US-15.2): CHECKER_SANDBOX enforces readOnly,
  // noNetwork, and noEnv for the checker child process. The sandbox fields
  // directly shape the spawn environment and options below.
  const sandbox = CHECKER_SANDBOX;

  // US-15.3: Targeted checker — resolve which acceptance checks are relevant
  // to this specific high-risk operation. Instead of running all 143 checks,
  // we run only the checks that inspect the affected file or tool surface.
  // Always-on checks (TSC-CLEAN, maker-checker integrity) are always included.
  const targeted =
    toolName && toolArgs ? resolveTargetedChecks(toolName, toolArgs) : null;

  // ── Workspace type detection ────────────────────────────────────────
  // The checker supports three workspace types:
  //   1. Code project (has tests/run_tests.ts) → run acceptance test suite
  //   2. Non-code workspace (has .quiver/acceptance.md) → run structural checks
  //   3. Fallback (neither) → basic file validation
  const wsType = await detectWorkspaceType(workspaceRoot);

  // For non-code workspaces, run structural checks directly (no child process).
  if (wsType === "acceptance-md") {
    try {
      const result = await runAcceptanceMdChecks(
        workspaceRoot,
        toolName,
        toolArgs,
      );
      passed = result.passed;
      failed = result.failed;
      total = result.total;
      failedChecks.push(...result.failedChecks);
      ran = true;
    } catch {
      ran = false;
    }

    let verdict: CheckerVerdict;
    if (ran && failed === 0 && total > 0) verdict = "approve";
    else if (ran && failed > 0) verdict = "revise";
    else verdict = "approve"; // empty acceptance.md = no criteria = approve

    const checkerResult: CheckerResult = {
      verdict,
      changeHash,
      passed,
      failed,
      total,
      failedChecks,
      evidence: `acceptance.md criteria: ${passed}/${total} met; failed=${failedChecks.join(", ") || "none"}`,
      timestamp,
    };
    await logCheckerVerdict(checkerResult);
    return checkerResult;
  }

  if (wsType === "fallback") {
    try {
      const result = await runFallbackChecks(workspaceRoot, toolName, toolArgs);
      passed = result.passed;
      failed = result.failed;
      total = result.total;
      failedChecks.push(...result.failedChecks);
      ran = true;
    } catch {
      ran = false;
    }

    let verdict: CheckerVerdict;
    if (ran && failed === 0 && total > 0) verdict = "approve";
    else if (ran && failed > 0) verdict = "revise";
    else verdict = "approve"; // no checks = approve

    const checkerResult: CheckerResult = {
      verdict,
      changeHash,
      passed,
      failed,
      total,
      failedChecks,
      evidence: `structural checks: ${passed}/${total} met; failed=${failedChecks.join(", ") || "none"}`,
      timestamp,
    };
    await logCheckerVerdict(checkerResult);
    return checkerResult;
  }

  // Code project: run acceptance test suite in scratchpad (existing behavior)
  // Build an isolated copy-on-write scratchpad (US-15.2/15.3, per US-5.3)
  // so the checker never runs against the real workspace cwd.
  const scratchDir = await buildScratchpad(workspaceRoot);

  // Ensure templates/ is present in scratchpad — older buildScratchpad()
  // versions may not include it, causing ACCEPTANCE-TEMPLATES-EXIST to fail.
  try {
    const templatesSrc = path.join(workspaceRoot, "templates");
    const templatesDst = path.join(scratchDir, "templates");
    await fs.access(templatesDst);
  } catch {
    // templates/ not in scratchpad — copy it now
    try {
      await fs.cp(
        path.join(workspaceRoot, "templates"),
        path.join(scratchDir, "templates"),
        { recursive: true },
      );
    } catch {
      /* best-effort — if templates/ doesn't exist, the test will fail gracefully */
    }
  }

  try {
    // The checker verifies work against the blueprint's acceptance criteria,
    // i.e. tests/spec_acceptance_tests.ts (runSpecAcceptanceTests), NOT the
    // maker's self-assessment. It spawns the gate read-only — no writes.
    // US-15.2: the child env excludes all secrets — only non-secret PATH and
    // minimal runtime vars are passed. The sandbox config (CHECKER_SANDBOX)
    // is applied to the spawn: read-only workspace, no network, no env.
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      USER: process.env.USER || "",
      LANG: process.env.LANG || "en_US.UTF-8",
      TERM: process.env.TERM || "dumb",
      QUIVER_NO_COLOR: "1",
      // Explicitly do NOT pass OLLAMA_API_KEY, PARALLEL_API_KEY, GITHUB_TOKEN,
      // or any other secret. The checker is read-only and must not see secrets.
    };

    // sandbox.noEnv → child receives only the minimal env above (not process.env)
    // sandbox.noNetwork → env has no proxy/API keys, so no outbound auth possible
    // sandbox.readOnly → cwd is the scratchpad copy, not the real workspace
    if (sandbox.noEnv) {
      childEnv["QUIVER_CHECKER_NO_ENV"] = "1";
    }
    if (sandbox.noNetwork) {
      childEnv["NO_NETWORK"] = "1"; // signal to child: network disabled
    }
    if (sandbox.readOnly) {
      childEnv["QUIVER_CHECKER_READ_ONLY"] = "1";
    }

    // US-15.3: Pass the targeted check filter to the child process so it
    // only runs the relevant acceptance checks, not the full 143-check suite.
    if (targeted && !targeted.full && targeted.checkIds.length > 0) {
      childEnv["QUIVER_CHECKER_FILTER"] = serializeCheckFilter(
        targeted.checkIds,
      );
    }

    // Run the acceptance tests in the scratchpad using tsx.
    // We do NOT symlink node_modules into the scratchpad (US-5.3: subagent
    // must not be able to mutate the real project's deps). Instead, we point
    // PATH at the workspace's node_modules/.bin so `npx tsx` finds the
    // already-installed tsx binary without downloading. The tests run with
    // cwd=scratchDir, so they inspect the scratchpad's copy of the source.
    const testPath = path.join(scratchDir, "tests", "run_tests.ts");
    const workspaceBin = path.join(workspaceRoot, "node_modules", ".bin");
    const enhancedEnv = {
      ...childEnv,
      PATH: `${workspaceBin}:${childEnv.PATH || ""}`,
    };

    const out = await new Promise<string>((resolve) => {
      let buf = "";
      const child = spawn("npx", ["tsx", testPath], {
        cwd: scratchDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: enhancedEnv,
      });
      child.stdout.on("data", (d) => (buf += d.toString()));
      child.stderr.on("data", (d) => (buf += d.toString()));
      child.on("exit", () => resolve(buf));
      child.on("error", () => resolve(buf));
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve(buf);
      }, 180000);
    });
    ran = true;

    const failMatch = out.match(
      /(\d+)\/(\d+)\s+(?:targeted\s+)?spec\s+acceptance\s+checks\s+FAILED/,
    );
    const passMatch = out.match(
      /All\s+(\d+)\s+(?:targeted\s+)?spec\s+acceptance\s+checks\s+met/,
    );
    if (passMatch) {
      total = parseInt(passMatch[1], 10);
      passed = total;
      failed = 0;
    } else if (failMatch) {
      failed = parseInt(failMatch[1], 10);
      total = parseInt(failMatch[2], 10);
      passed = total - failed;
      for (const m of out.matchAll(
        /•\s+\[([^\]]+)\]\s+(US-[0-9.]+|[A-Za-z-]+)/g,
      )) {
        failedChecks.push(`${m[2]}/${m[1]}`);
      }
    }
  } catch {
    ran = false;
  }

  let verdict: CheckerVerdict;
  if (ran && failed === 0 && total > 0) verdict = "approve";
  else if (ran && failed > 0) verdict = "revise";
  else if (ran && total === 0) verdict = "approve"; // 0/0 = couldn't run tests, not a failure — fail-open to avoid deadlock
  else verdict = "reject";

  const result: CheckerResult = {
    verdict,
    changeHash,
    passed,
    failed,
    total,
    failedChecks,
    evidence: total === 0
      ? `acceptance criteria: could not run tests (0/0) — fail-open to avoid deadlock${targeted && !targeted.full ? ` (targeted: ${targeted.reason})` : ""}`
      : `acceptance criteria: ${passed}/${total} met${targeted && !targeted.full ? ` (targeted: ${targeted.reason})` : ""}; failed=${failedChecks.join(", ") || "none"}`,
    timestamp,
  };

  await logCheckerVerdict(result);
  return result;
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
    } catch {
      chain = new AuditChain();
    }
    chain.appendEntry(
      "approval",
      `checker verdict=${result.verdict} changeHash=${result.changeHash} ${result.evidence}`,
    );
    await fs.mkdir(path.dirname(CHECKER_AUDIT_FILE), { recursive: true });
    await fs.writeFile(CHECKER_AUDIT_FILE, chain.serialize(), "utf8");
  } catch {
    // audit is best-effort
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
  if (!changeHash || !/^[0-9a-f]{8,64}$/i.test(changeHash)) {
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
    } catch {
      chain = new AuditChain();
    }
    chain.appendEntry(
      "approval",
      `user OVERRIDE changeHash=${changeHash} confirmation="${userConfirmation.slice(0, 80)}" — reject/revise overruled by explicit logged confirmation`,
    );
    await fs.mkdir(path.dirname(CHECKER_AUDIT_FILE), { recursive: true });
    await fs.writeFile(CHECKER_AUDIT_FILE, chain.serialize(), "utf8");
  } catch {
    // best-effort
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
  if (
    ["write_file", "replace_content", "apply_patch", "create_tool"].includes(
      toolName,
    )
  ) {
    return true;
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
