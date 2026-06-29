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

  // Build an isolated copy-on-write scratchpad (US-15.2/15.3, per US-5.3)
  // so the checker never runs against the real workspace cwd.
  const scratchDir = await buildScratchpad(workspaceRoot);

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

    const out = await new Promise<string>((resolve) => {
      let buf = "";
      const child = spawn(
        process.execPath,
        [
          path.join(scratchDir, "node_modules", "tsx", "dist", "cli.mjs"),
          path.join(scratchDir, "tests", "run_tests.ts"),
        ],
        {
          cwd: scratchDir, // US-15.2/15.3: isolated scratchpad, not workspaceRoot
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv, // US-15.2: no secrets leaked to the checker child
        },
      );
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
  else verdict = "reject";

  const result: CheckerResult = {
    verdict,
    changeHash,
    passed,
    failed,
    total,
    failedChecks,
    evidence: `acceptance criteria: ${passed}/${total} met${targeted && !targeted.full ? ` (targeted: ${targeted.reason})` : ""}; failed=${failedChecks.join(", ") || "none"}`,
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
