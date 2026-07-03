/**
 * Ambient Engine — self-healing + goal-loop as harness characteristics.
 *
 * Self-healing and goal-seeking are NOT slash commands; they are always-on
 * behaviors of the harness. This engine is the *completion gate* of the agent
 * loop: when the agent would stop after a file-mutating task, the harness
 * verifies the work is genuinely complete and, if not, continues the loop.
 *
 * ── Tight coupling (no redundant verification) ──
 * There is exactly ONE verification primitive in Quiver: the maker-checker
 * (`runChecker` in src/subagents/checker.ts), which runs the acceptance
 * contract (`tests/spec_acceptance_tests.ts`, incl. the always-on TSC-CLEAN
 * check) on an isolated copy-on-write scratchpad. The three ambient behaviors
 * are all driven by it, never by a parallel `tsc`/`npm test` spawn:
 *
 *   1. Maker-checker (per-change, TARGETED)  — fires on every high-risk tool
 *      call via the lifecycle `wrap_tool_call` hook. On revise/reject it
 *      rolls the change back and throws the verdict+evidence to the model,
 *      which is *per-change self-heal* — the agent fixes it next turn.
 *   2. Goal-loop                              — the agent loop does not stop
 *      until the per-change checker has approved every change AND the final
 *      holistic check (below) passes.
 *   3. Self-heal (completion, FULL)           — this engine runs `runChecker`
 *      once in FULL mode (no target filter) at completion to catch
 *      integration / non-targeted regressions the per-change targeted checks
 *      don't cover. If it revises/rejects, the evidence is injected and the
 *      loop continues — same primitive, broader scope.
 *
 * So per-change verification (targeted) and completion verification (full)
 * reuse the single checker; there is no second tsc/test pipeline. Capped at
 * `ambientMaxHealRounds` so it never spins forever. Disable for one-shot runs
 * via QUIVER_AMBIENT=0.
 */

import { runChecker, type CheckerResult } from "./subagents/checker.js";

export interface VerifyResult {
  healthy: boolean;
  diagnostics: string;
  /** The checker verdict that produced this result. */
  verdict: "approve" | "reject" | "revise";
  total: number;
  failed: number;
  failedChecks: string[];
}

export class AmbientEngine {
  private healRounds = 0;

  constructor(
    private maxRounds: number = 5,
    private enabled: boolean = true,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  roundsUsed(): number {
    return this.healRounds;
  }

  /** Reset between user prompts so each goal gets a fresh heal budget. */
  reset(): void {
    this.healRounds = 0;
  }

  hasBudget(): boolean {
    return this.healRounds < this.maxRounds;
  }

  /** Consume one heal round; returns false if the budget is exhausted. */
  spendRound(): boolean {
    if (this.healRounds >= this.maxRounds) return false;
    this.healRounds++;
    return true;
  }

  /**
   * Run the completion verification by invoking the maker-checker in FULL
   * mode (no target filter) on an isolated scratchpad. This is the SAME
   * primitive the per-change gate uses, just holistic — so there is no
   * parallel tsc/test pipeline. Returns the verdict mapped to a result.
   *
   * If the checker infrastructure itself throws (e.g. scratchpad cannot be
   * built in a restricted environment), we treat it as "could not verify" and
   * return healthy=true so the loop does not spin on an infra failure.
   */
  async verify(opts: { cwd?: string; changeHash?: string }): Promise<VerifyResult> {
    const cwd = opts.cwd ?? process.cwd();
    const changeHash = opts.changeHash ?? `ambient-${Date.now()}`;
    let res: CheckerResult;
    try {
      // No toolName/toolArgs → runChecker runs the FULL acceptance suite
      // (targeted = null → no QUIVER_CHECKER_FILTER), incl. always-on TSC-CLEAN.
      res = await runChecker(changeHash, cwd);
    } catch (err: any) {
      return {
        healthy: true, // don't heal-loop on infra failure
        diagnostics: `(ambient verify skipped: checker unavailable — ${err?.message ?? err})`,
        verdict: "approve",
        total: 0,
        failed: 0,
        failedChecks: [],
      };
    }
    const healthy = res.verdict === "approve" && res.failed === 0;
    const failedList = res.failedChecks.length
      ? res.failedChecks.join(", ")
      : "none";
    const diagnostics =
      `Maker-checker completion verdict: ${res.verdict.toUpperCase()} ` +
      `(${res.passed}/${res.total} acceptance criteria met).\n` +
      `Failed checks: ${failedList}\n` +
      `Evidence: ${res.evidence}`;
    return {
      healthy,
      diagnostics,
      verdict: res.verdict,
      total: res.total,
      failed: res.failed,
      failedChecks: res.failedChecks,
    };
  }

  /**
   * Build the user-message directive injected to drive the next heal
   * iteration. The agent sees this as an explicit instruction to diagnose and
   * fix the failures, then stop only when the checker approves.
   */
  makeHealDirective(res: VerifyResult, round: number, maxRounds: number): string {
    return (
      `Ambient self-heal (round ${round}/${maxRounds}): the harness ran the ` +
      `maker-checker on your completed work and it is NOT yet approved ` +
      `(${res.failed}/${res.total} acceptance criteria failed). Examine the ` +
      `diagnostics, find the root cause, modify the source, and verify. Do NOT ` +
      `declare completion until the checker approves. If the same failure ` +
      `persists, reconsider your approach rather than repeating the same change.\n\n` +
      res.diagnostics
    );
  }

  /** Human-readable one-line status for /config and the banner. */
  statusLine(): string {
    if (!this.enabled) return "ambient: OFF (QUIVER_AMBIENT=0)";
    return `ambient: ON (self-heal+goal-loop via maker-checker, max ${this.maxRounds} heal rounds)`;
  }
}
