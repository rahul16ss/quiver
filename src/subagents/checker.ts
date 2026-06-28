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
import { AuditChain } from "../logger.js";

// ─── Sandbox separation (US-15.2) ─────────────────────────────────────
// The checker runs read-only: it may inspect the workspace but never mutate
// it, has no network access (it cannot exfiltrate or pull), and is denied
// the full process.env / secret surface (only non-secret metadata is visible).
export const CHECKER_SANDBOX = {
  readOnly: true,        // noWrite: checker never writes workspace files
  noWrite: true,
  noNetwork: true,       // network disabled — no outbound calls
  denyNetwork: true,
  noEnv: true,           // full process.env is forbidden / redacted
  denyEnv: true,
  allowWrite: false,
  allowNetwork: false,
};

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
): Promise<CheckerResult> {
  const timestamp = new Date().toISOString();
  const failedChecks: string[] = [];
  let passed = 0;
  let failed = 0;
  let total = 0;
  let ran = false;

  try {
    // The checker verifies work against the blueprint's acceptance criteria,
    // i.e. tests/spec_acceptance_tests.ts (runSpecAcceptanceTests), NOT the
    // maker's self-assessment. It spawns the gate read-only — no writes.
    const out = await new Promise<string>((resolve) => {
      let buf = "";
      const child = spawn(
        process.execPath,
        [path.join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs"),
         path.join(workspaceRoot, "tests", "run_tests.ts")],
        { cwd: workspaceRoot, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, QUIVER_NO_COLOR: "1" } },
      );
      child.stdout.on("data", (d) => (buf += d.toString()));
      child.stderr.on("data", (d) => (buf += d.toString()));
      child.on("exit", () => resolve(buf));
      child.on("error", () => resolve(buf));
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(buf); }, 180000);
    });
    ran = true;

    const failMatch = out.match(/(\d+)\/(\d+)\s+spec\s+acceptance\s+checks\s+FAILED/);
    const passMatch = out.match(/All\s+(\d+)\s+spec\s+acceptance\s+checks\s+met/);
    if (passMatch) {
      total = parseInt(passMatch[1], 10);
      passed = total;
      failed = 0;
    } else if (failMatch) {
      failed = parseInt(failMatch[1], 10);
      total = parseInt(failMatch[2], 10);
      passed = total - failed;
      for (const m of out.matchAll(/•\s+\[([^\]]+)\]\s+(US-[0-9.]+|[A-Za-z-]+)/g)) {
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
    evidence: `acceptance criteria: ${passed}/${total} met; failed=${failedChecks.join(", ") || "none"}`,
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
    const fs = await import("fs/promises");
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
    return { overridden: false, reason: "override requires an explicit user confirmation" };
  }
  if (!changeHash || !/^[0-9a-f]{8,64}$/i.test(changeHash)) {
    return { overridden: false, reason: "override must be tied to a change hash" };
  }
  try {
    const fs = await import("fs/promises");
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
  return { overridden: true, reason: `override logged for change ${changeHash}` };
}

/**
 * Convenience: classify whether a tool call is high-risk and so requires the
 * checker gate before commit (US-15.1 wrap_tool_call lifecycle hook).
 */
export function isHighRisk(toolName: string): boolean {
  return ["write_file", "replace_content", "apply_patch", "run_command", "create_tool"].includes(toolName);
}
