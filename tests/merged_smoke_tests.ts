/**
 * Merged smoke-regression checks — CHECKER-OWNED, gated.
 *
 * These checks were ported from the maker-authored standalone smoke files
 * (`tests/ambient_test.ts`, `tests/permissions_ladder_test.ts`,
 * `tests/truncation_stress_test.ts`) during the 2026-07-02 de-duplication pass.
 * The standalone files are deleted; the *unique, discriminating* checks they
 * carried are preserved here and wired into the single acceptance gate so
 * `npm test` enforces them (they previously ran only when invoked by hand and
 * were therefore not acceptance evidence).
 *
 * Unlike `architect_review_tests.ts` (which FAILS today — vendor must fix),
 * these checks PASS against the current tree: they are *regression* coverage
 * for behavior that is already implemented (US-6.4 mid-tier approvals, US-13.5
 * ambient glue, US-17.1 truncation recovery). They guard against silent
 * regressions of that working behavior. They can be targeted via
 * QUIVER_CHECKER_FILTER like every other gate family.
 *
 * Design rules (same discipline as the rest of the contract):
 *  - Behavioral (import + call real modules) for the tier/ambient/cache logic.
 *  - Source-text (`codeOnly`, comments stripped) for the truncation-recovery
 *    wiring in `src/agent.ts` (a behavioral test would need a streaming mock).
 *  - The contract snapshots and restores the global `config` singleton so the
 *    tier mutations here never leak into other gate families.
 */
import picocolors from "picocolors";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

import { config, applyTrustTier, needsApprovalFor, hasGrant } from "../src/config.js";
import { createDefaultPolicy, checkPathAllowed } from "../src/security/path_policy.js";
import { ApprovalCache } from "../src/security/approval_cache.js";
import { AmbientEngine } from "../src/ambient.js";
import { readQueue, summarizeQueue, watchdogStatus } from "../src/watchdog.js";

interface CheckResult {
  id: string;
  story: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];
const ROOT = path.resolve(".");

function codeOnly(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) return "";
  let t = readFileSync(p, "utf8");
  t = t.replace(/\/\*[\s\S]*?\*\//g, " ");
  t = t.replace(/^\s*\/\/.*$/gm, " ");
  return t;
}

export async function mergedSmokeContract(
  push: (r: CheckResult) => void,
): Promise<void> {
  const _filterEnv = process.env.QUIVER_CHECKER_FILTER || "";
  const _filterSet: Set<string> | null = _filterEnv
    ? new Set(
        _filterEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  async function check(
    id: string,
    story: string,
    detail: string,
    fn: () => boolean | Promise<boolean>,
  ) {
    if (_filterSet && !_filterSet.has(id)) {
      console.log(picocolors.gray(`   ⊘ SKIP  [${story}] ${id}`));
      return;
    }
    let passed = false;
    let actual = detail;
    try {
      passed = await fn();
    } catch (err: any) {
      passed = false;
      actual = `${detail} — threw: ${err?.message || String(err)}`;
    }
    const cr: CheckResult = { id, story, passed, detail: actual };
    results.push(cr);
    push(cr);
    const tag = passed
      ? picocolors.green("   ✔ PASS")
      : picocolors.red("   ✗ FAIL");
    console.log(`${tag}  [${story}] ${id}`);
    if (!passed) console.log(picocolors.gray(`           ${actual}`));
  }

  // ─── US-13.5: AmbientEngine heal directive + status line (behavioral) ──

  await check(
    "AMBIENT-HEAL-DIRECTIVE-CONTENT",
    "US-13.5",
    "makeHealDirective must produce a substantive steering directive that names the failed checks, says the work is not approved, and references the maker-checker — not an empty/generic string",
    () => {
      const eng = new AmbientEngine(5, true);
      const directive = eng.makeHealDirective(
        {
          healthy: false,
          verdict: "revise" as const,
          total: 133,
          failed: 3,
          failedChecks: ["US-9.2/PATH-X", "US-6.2/CMD-Y"],
          diagnostics:
            "Maker-checker completion verdict: REVISE (130/133 met).\nFailed checks: US-9.2/PATH-X, US-6.2/CMD-Y",
        },
        1,
        5,
      );
      return (
        directive.length > 50 &&
        directive.includes("US-9.2/PATH-X") &&
        /not.*approved/i.test(directive) &&
        /maker-checker/i.test(directive)
      );
    },
  );

  await check(
    "AMBIENT-STATUS-LINE",
    "US-13.5",
    "statusLine must reflect enabled state (ON when enabled, OFF when disabled) and mention the maker-checker primitive when enabled",
    () => {
      const on = new AmbientEngine(5, true);
      const off = new AmbientEngine(5, false);
      return (
        on.statusLine().includes("ON") &&
        on.statusLine().includes("maker-checker") &&
        off.isEnabled() === false &&
        off.statusLine().includes("OFF")
      );
    },
  );

  // ─── US-6.4: mid-tier approval behavior (the gate only covers observe/yolo) ──

  await check(
    "TRUST-TIER-PROPOSE-APPROVALS",
    "US-6.4",
    "At the propose tier, memory/todo auto-approve but web_search and safe run_command still require approval — the gate only asserts the observe & yolo extremes",
    () => {
      applyTrustTier("propose");
      try {
        return (
          !needsApprovalFor("todo_write") &&
          !needsApprovalFor("memory_append") &&
          needsApprovalFor("web_search") &&
          needsApprovalFor("run_command", "safe")
        );
      } finally {
        applyTrustTier(null);
      }
    },
  );

  await check(
    "TRUST-TIER-BUILD-APPROVALS",
    "US-6.4",
    "At the build tier, safe run_command and web auto-approve but destructive run_command still requires approval",
    () => {
      applyTrustTier("build");
      try {
        return (
          !needsApprovalFor("run_command", "safe") &&
          needsApprovalFor("run_command", "destructive") &&
          !needsApprovalFor("web_search")
        );
      } finally {
        applyTrustTier(null);
      }
    },
  );

  await check(
    "TRUST-TIER-BUILD-GRANTS-WEB",
    "US-6.4",
    "The build tier must grant the web grant (cumulative ladder: propose lacks web, build adds it)",
    () => {
      applyTrustTier("build");
      try {
        return hasGrant("web") === true;
      } finally {
        applyTrustTier(null);
      }
    },
  );

  await check(
    "TRUST-TIER-NULL-CLEARS",
    "US-6.4",
    "applyTrustTier(null) must clear all autonomy grants (no tier = no autonomous capabilities)",
    () => {
      applyTrustTier("yolo");
      applyTrustTier(null);
      return config.autonomyGrants.size === 0;
    },
  );

  // ─── US-6.4: allow-glob + read-scope behavioral enforcement ───────────

  let tmp = "";
  let outside = "";
  try {
    tmp = path.join(os.tmpdir(), `quiver-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "ok.txt"), "ok");
    const sub = path.join(tmp, "src");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, "a.ts"), "x");
    outside = path.join(os.tmpdir(), `quiver-smoke-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    writeFileSync(outside, "secret");

    await check(
      "ALLOW-GLOBS-EMPTY-ALLOWS-ALL",
      "US-6.4",
      "An empty writeAllowGlobs list must allow all in-workspace writes (the complement of glob enforcement — empty means unrestricted, not block-all)",
      () => {
        const policy = createDefaultPolicy(tmp);
        return checkPathAllowed(path.join(tmp, "ok.txt"), "write", policy) === null;
      },
    );

    await check(
      "READ-SCOPE-ENFORCED-BEHAVIORAL",
      "US-6.4/US-9.2",
      "readScope=workspace must behaviorally confine reads to the workspace (inside ok, outside blocked); readScope=filesystem must allow the same outside read",
      () => {
        const wsPolicy = createDefaultPolicy(tmp);
        wsPolicy.readScope = "workspace";
        const insideOk =
          checkPathAllowed(path.join(tmp, "ok.txt"), "read", wsPolicy) === null;
        const outsideBlocked =
          checkPathAllowed(outside, "read", wsPolicy) !== null;
        wsPolicy.readScope = "filesystem";
        const fsOk = checkPathAllowed(outside, "read", wsPolicy) === null;
        return insideOk && outsideBlocked && fsOk;
      },
    );

    await check(
      "APPROVAL-CACHE-ONCE-NOT-CACHED",
      "US-2.4",
      "once-scoped approvals must NOT be cached (only session scope persists); clear() empties the cache",
      () => {
        const cache = new ApprovalCache();
        const key = { toolName: "run_command", riskBand: "moderate" };
        const emptyOk = !cache.has(key);
        cache.record(key, "session");
        const sessionHit = cache.has(key);
        const onceKey = { toolName: "write_file", dir: "src" };
        cache.record(onceKey, "once");
        const onceNotCached = !cache.has(onceKey);
        cache.clear();
        const clearedOk = !cache.has(key) && cache.size() === 0;
        return emptyOk && sessionHit && onceNotCached && clearedOk;
      },
    );
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (outside) rmSync(outside, { force: true });
  }

  // ─── US-17.1: truncation recovery wiring in the real agent loop (source-text) ──

  await check(
    "TRUNCATION-CONTINUATION-PROMPT",
    "US-17.1",
    "On mid-text truncation the agent must inject a 'Continue from where you left off' continuation prompt so the model resumes without repeating itself",
    () => /Continue from where you left off/.test(codeOnly("src/agent.ts")),
  );

  await check(
    "TRUNCATION-RECOVERY-LOGGED",
    "US-17.1",
    "The agent must emit truncation_recovery and truncation_recovery_exhausted audit events (recovery is observable, not silent)",
    () => {
      const a = codeOnly("src/agent.ts");
      return /truncation_recovery/.test(a) && /truncation_recovery_exhausted/.test(a);
    },
  );

  await check(
    "TRUNCATION-PARTIAL-TOOL-CALL-BRANCH",
    "US-17.1",
    "The agent must distinguish mid-tool-call truncation from mid-text truncation via hasPartialToolCalls and raise maxOutputTokens only for the tool-call case",
    () =>
      /hasPartialToolCalls\s*=\s*Object\.keys\(accumulatedToolCalls\)\.length\s*>\s*0/.test(
        codeOnly("src/agent.ts"),
      ),
  );

  await check(
    "TRUNCATION-RAISE-PERSISTED",
    "US-17.1",
    "The raised maxOutputTokens must be persisted back onto adapterDefaults (not just a local variable) so the retry actually uses the larger budget",
    () =>
      /adapterDefaults\.maxOutputTokens\s*=\s*newMax/.test(codeOnly("src/agent.ts")),
  );

  await check(
    "TRUNCATION-ACCUMULATORS-RESET",
    "US-17.1",
    "Before a truncation retry the agent must reset assistantContent / firstStreamingToken / accumulatedToolCalls so the resumed stream is not double-counted",
    () =>
      /assistantContent\s*=\s*""\s*;[\s\S]*?firstStreamingToken\s*=\s*true\s*;[\s\S]*?accumulatedToolCalls\s*=\s*\{\s*\}/.test(
        codeOnly("src/agent.ts"),
      ),
  );

  // ─── Self-Heal: tool-call argument poisoning recovery (provider 400) ──
  // Regression coverage for the un-healable 400 loop: a malformed tool-call
  // arguments string persisted into history made every subsequent prompt
  // (including a user's "self heal") fail with HTTP 400 "invalid tool call
  // arguments". Two layers must be wired in src/agent.ts: (A) sanitize
  // arguments before they enter history, and (B) repair history + retry on
  // a 400 so an already-poisoned session recovers instead of looping.

  await check(
    "SELF-HEAL-SANITIZE-ON-PERSIST",
    "US-13.4",
    "The assistant tool_calls pushed into history must pass arguments through sanitizeToolCallArguments so malformed JSON never enters the message log (prevents a permanent provider 400 on the next turn)",
    () =>
      /sanitizeToolCallArguments\(raw\.arguments\)/.test(
        codeOnly("src/agent.ts"),
      ),
  );

  await check(
    "SELF-HEAL-REPAIR-METHOD",
    "US-13.4",
    "A repairToolCallHistory method must exist that fixes malformed tool_calls.arguments in place and drops orphaned tool results whose tool_call_id no longer references a surviving call",
    () => {
      const a = codeOnly("src/agent.ts");
      return (
        /repairToolCallHistory\(\)/.test(a) &&
        /survivingCallIds/.test(a) &&
        /orphan/.test(a)
      );
    },
  );

  await check(
    "SELF-HEAL-400-RETRY",
    "US-13.4",
    "On a provider 400 \"invalid tool call arguments\" the agent must repair history and retry the model call once (guarded by historyRepaired) rather than treating it as a transient connection failure and retrying the same poisoned request 3x",
    () => {
      const a = codeOnly("src/agent.ts");
      return (
        /invalid tool call arguments/.test(a) &&
        /historyRepaired/.test(a) &&
        /self_heal_tool_args_repair/.test(a)
      );
    },
  );

  await check(
    "SELF-HEAL-SANITIZE-VALID-JSON",
    "US-13.4",
    "sanitizeToolCallArguments must coerce non-JSON / markdown-fenced / empty input to a valid \"{}\" string so the persisted tool call is always a parseable JSON object",
    () => {
      const a = codeOnly("src/agent.ts");
      return (
        /sanitizeToolCallArguments/.test(a) &&
        /```(?:json)?/.test(a) &&
        /return "\{\}"/.test(a)
      );
    },
  );

  await check(
    "SELF-HEAL-MALFORMED-JSON-DIAGNOSTIC",
    "US-13.4",
    "When the model emits malformed JSON arguments, the agent must short-circuit before schema validation and return an accurate 'Malformed tool-call arguments (not valid JSON)' diagnostic (with the parse error) instead of the misleading 'filePath: Required' from validating an empty args object",
    () => {
      const a = codeOnly("src/agent.ts");
      return (
        /argsParseError/.test(a) &&
        /Malformed tool-call arguments \(not valid JSON\)/.test(a) &&
        /tool_args_malformed_json/.test(a)
      );
    },
  );

  // ── UX: animated "working" indicator (no more frozen "Thinking…") ──
  // The Spinner was a no-op that printed a static line for the whole think
  // duration, which read as a hang. It must now animate: a rotating frame +
  // elapsed seconds via setInterval, with stop() clearing the interval and
  // the exact width written so no stray characters leak into streamed output.

  await check(
    "SPINNER-ANIMATES-ELAPSED",
    "US-2.2",
    "The Spinner must animate (setInterval repaint + elapsed seconds) so a long think is visibly alive, not a frozen 'Thinking…' line",
    () => {
      const a = codeOnly("src/agent.ts");
      return (
        /class Spinner/.test(a) &&
        /setInterval\(.*Spinner|setInterval\(/.test(a) &&
        /FRAMES/.test(a) &&
        /elapsed/.test(a) &&
        !/is a no-op/.test(a)
      );
    },
  );

  await check(
    "SPINNER-STOP-CLEARS-INTERVAL-AND-WIDTH",
    "US-2.2",
    "Spinner.stop() must clearInterval and wipe the max width written (not just message.length+6) so a shorter repaint never leaves stray characters and no timer leaks",
    () => {
      const a = codeOnly("src/agent.ts");
      return (
        /clearInterval\(this\.timer\)/.test(a) &&
        /maxWidth/.test(a) &&
        /this\.maxWidth/.test(a)
      );
    },
  );

  await check(
    "MODEL-ERROR-HONEST-LABEL",
    "US-2.2",
    "Model-call failures must be labeled honestly (classifyModelError: auth / 4xx / 5xx / timeout / connection / cancelled) instead of the blanket 'Connection failed' that was wrong for request rejections",
    () => {
      const a = codeOnly("src/agent.ts");
      return (
        /classifyModelError/.test(a) &&
        /Auth failed/.test(a) &&
        /Request rejected by provider/.test(a) &&
        /Provider error \(HTTP 5xx\)/.test(a)
      );
    },
  );

  // ── UX: huge-paste handling in the multiline editor ───────────────────
  // Pasting a large blob used to flood the terminal and make every subsequent
  // keystroke O(buffer) because render() redraw the entire buffer each frame.
  // The editor must now window the render around the cursor (collapsed ↑/↓
  // hidden-line summaries) so display + edits are O(window), while still
  // submitting the full text on Enter.

  await check(
    "MULTILINE-WINDOWED-RENDER",
    "US-2.2",
    "The multiline editor must collapse large buffers in render() — render only a cursor-centered window of lines with ↑/↓ hidden-line summaries, never the whole buffer — so a huge paste doesn't flood the terminal or lag per-keystroke",
    () => {
      const a = codeOnly("src/multiline.ts");
      return (
        /MAX_RENDER_LINES/.test(a) &&
        /winStart/.test(a) &&
        /winEnd/.test(a) &&
        /hidden/.test(a) &&
        /full text sends on Enter/.test(a)
      );
    },
  );

  await check(
    "MULTILINE-WINDOW-CURSOR-MATH",
    "US-2.2",
    "The windowed render must keep cursor positioning correct and O(window) — crow starts at headerRows and the row loop iterates only the visible window (winStart..cLine), not the whole buffer",
    () => {
      const a = codeOnly("src/multiline.ts");
      return (
        /let crow = headerRows/.test(a) &&
        /for \(let li = winStart; li < cLine; li\+\+\)/.test(a)
      );
    },
  );

  // ── Watchdog: continuous self-health monitor (behavioral) ──
  // The watchdog writes a JSONL findings queue that the agent can read via
  // /watchdog. These checks verify the read/summarize/status surface used by
  // the slash command actually works against a real queue file, so the
  // triage loop (watchdog → /watchdog → fix) is end-to-end wired.

  await check(
    "WATCHDOG-QUEUE-READ-PARSE",
    "US-13.4",
    "readQueue must parse the JSONL findings queue into structured WatchdogFinding objects (skipping blank/malformed lines)",
    () => {
      const findings = readQueue();
      return Array.isArray(findings) && findings.every(
        (f) => f && typeof f.kind === "string" && typeof f.severity === "string",
      );
    },
  );

  await check(
    "WATCHDOG-SUMMARIZE-GROUPS-BY-KIND",
    "US-13.4",
    "summarizeQueue must group findings by kind and include every finding's key + detail so the /watchdog display is complete and non-empty when findings exist",
    () => {
      const findings = readQueue();
      const summary = summarizeQueue(findings);
      // When the queue has findings, every finding's key must appear in the summary.
      if (findings.length === 0) return true; // nothing to summarize is valid
      return findings.every((f) => summary.includes(f.key)) && summary.length > 0;
    },
  );

  await check(
    "WATCHDOG-STATUS-ALIVE-LINE",
    "US-13.4",
    "watchdogStatus must render an alive/not-alive liveness line and list queue findings (or the empty-queue message), matching the slash-command output",
    () => {
      const out = watchdogStatus();
      return /Watchdog/.test(out) && /(alive|not alive|no heartbeat)/.test(out) && /Queue/.test(out);
    },
  );

  await check(
    "WATCHDOG-COMMAND-REGISTERED",
    "US-13.4",
    "The /watchdog slash command must be registered (with /wd alias) and dispatched in the CLI so the in-agent triage loop works",
    () => {
      const cmds = codeOnly("src/slash_commands.ts");
      const cli = codeOnly("src/cli.ts");
      return (
        /name: "\/watchdog"/.test(cmds) &&
        /aliases: \["\/wd"\]/.test(cmds) &&
        /case "\/watchdog":/.test(cli) &&
        /watchdogStatus/.test(cli)
      );
    },
  );
}