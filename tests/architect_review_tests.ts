/**
 * Architect-Review acceptance checks — CHECKER-OWNED.
 *
 * These checks were authored from the independent architect review recorded in
 * `.spec-swimlane.md` → "PART 5: ARCHITECT REVIEW COMMENTS" (added 2026-07-02).
 * Unlike the rest of the contract (which asserts the spec baseline), these
 * assert the *fail-closed / discriminating* behaviors the review found missing.
 *
 * Design rules (same discipline as spec_acceptance_tests.ts):
 *  - Behavioral (import + call real modules) wherever the API is cleanly
 *    importable and the check does not need a live network/Electron/subprocess
 *    harness.
 *  - Source-text (`codeOnly`, comments stripped) where the defect is structural
 *    and a behavioral test would require heavy infrastructure (Electron
 *    launch, MCP server spawn, process-level fault injection). These assert
 *    the presence of a required guard or the absence of a swallow/bypass, so
 *    they cannot be satisfied by keyword theater — the vendor must actually
 *    wire the fix.
 *
 * Every check here FAILS against the current tree (the bugs are real) and
 * passes only after the vendor closes the gap. `npm test` stays RED until then,
 * which is the intended bar. Checks can be targeted via QUIVER_CHECKER_FILTER.
 *
 * IMPORTANT: this file only *adds* checks; it never edits source under src/ or
 * ui/. The vendor fixes the code, not the checks.
 */
import picocolors from "picocolors";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";

import { classifyCommand } from "../src/security/command_policy.js";
import { generateSeatbeltProfile } from "../src/security/seatbelt.js";
import { DefaultAdapter } from "../src/adapters/types.js";

interface CheckResult {
  id: string;
  story: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];
const ROOT = path.resolve(".");

// Source text with comments stripped (anti keyword-theater), mirrors the main
// contract's codeOnly helper.
function codeOnly(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) return "";
  let t = readFileSync(p, "utf8");
  t = t.replace(/\/\*[\s\S]*?\*\//g, " ");
  t = t.replace(/^\s*\/\/.*$/gm, " ");
  return t;
}

// Minimal `check` mirror — appends to the SAME results array the main runner
// tallies. (Wired via architectReviewContract returning these results, which
// the main file splices into its own `results`.)
export async function architectReviewContract(
  push: (r: CheckResult) => void,
): Promise<void> {
  // Honor the targeted-checker filter (US-15.3) the same way the main contract
  // does, so the maker-checker gate can run a subset of these checks.
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

  // ─── C-5 / H-13: command-classifier bypasses (behavioral) ─────────────

  await check(
    "AR-CMD-DOUBLE-QUOTE-OBFUSCATION",
    "US-6.2",
    "classifyCommand must treat double-quote-split commands (r\"m\" -rf /) as destructive — only empty adjacent \"\" are stripped today, so quotes around non-empty content bypass the rm detector",
    () => {
      const c = classifyCommand('r"m" -rf /');
      return c.requiresApproval === true || c.risk === "destructive";
    },
  );

  await check(
    "AR-CMD-RM-RECURSIVE-LONGFORM",
    "US-6.2",
    "classifyCommand must treat 'rm --recursive --force /' and 'rm -r --force /' as destructive — the destructive regex only matches short -rf/-fr + a trailing-space --force, so long-form --recursive is not detected",
    () => {
      const a = classifyCommand("rm --recursive --force /");
      const b = classifyCommand("rm -r --force /");
      return (
        (a.requiresApproval === true || a.risk === "destructive") &&
        (b.requiresApproval === true || b.risk === "destructive")
      );
    },
  );

  await check(
    "AR-CMD-SECRET-EXFIL-BYPASS",
    "US-6.2",
    "classifyCommand must flag secret-exfil vectors that currently fall into the 'safe' band: bare 'env' (prints every env var incl. GITHUB_TOKEN), 'cp ~/.ssh/id_rsa /tmp/x', 'mv ~/.aws/credentials /tmp/x', 'cat /etc/passwd'",
    () => {
      const cases = [
        "env",
        "cp ~/.ssh/id_rsa /tmp/leak",
        "mv ~/.aws/credentials /tmp/leak",
        "cat /etc/passwd",
      ];
      return cases.every((cmd) => {
        const c = classifyCommand(cmd);
        return (
          c.requiresApproval === true ||
          c.risk === "secret-risk" ||
          c.risk === "exfiltration-risk" ||
          c.risk === "destructive"
        );
      });
    },
  );

  // ─── C-4: seatbelt profile path-escaping (behavioral) ────────────────

  await check(
    "AR-SEATBELT-PATH-ESCAPING",
    "US-17.10",
    "generateSeatbeltProfile must escape or reject double-quotes in path inputs — today it interpolates workspaceRoot/extraWritePaths raw into double-quoted Sandbox-Profile strings, so a project named with a \") (allow file-write* (subpath \"/\")) breaks out of the write jail",
    () => {
      const malicious = 'foo") (allow file-write* (subpath "/")) (deny file-read* (subpath "/x';
      try {
        const profile = generateSeatbeltProfile({
          workspaceRoot: malicious,
          allowNetwork: false,
          extraReadPaths: [],
          extraWritePaths: [],
        });
        // A correct fix escapes the embedded double-quotes (backslash-quote)
        // or rejects the path. Raw interpolation leaves every `"` unescaped.
        return profile.includes('\\"');
      } catch {
        // Rejecting the malformed path is also an acceptable fail-closed fix.
        return true;
      }
    },
  );

  // ─── C-7: trust-tier via env must not crash and must apply (behavioral) ──

  await check(
    "AR-TRUST-TIER-ENV-APPLIES",
    "US-6.4",
    "QUIVER_AUTONOMY=tier:operate must not crash startup and must apply the tier — applyTrustTier must run AFTER `config` is initialized (temporal dead zone), so tier:* must not ReferenceError-crash at startup and must actually set readScope/sandboxOff. Probed via `node --import tsx` (NOT the tsx CLI, whose IPC named-socket EPERMs in restricted sandboxes and masks the real behaviour).",
    () => {
      const tmpHome = path.join(
        os.tmpdir(),
        `quiver-ar-tier-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      );
      mkdirSync(tmpHome, { recursive: true });
      // Write a real .ts probe file and run it with `node --import tsx`. This
      // avoids the tsx CLI's IPC-server listen() (EPERM in sandboxes) while
      // still exercising the real module-load path where the TDZ crash lives.
      const probe = path.join(tmpHome, "probe.ts");
      const script =
        `import { config } from ${JSON.stringify(path.join(ROOT, "src/config.ts"))};\n` +
        `process.stdout.write(String(config.trustTier || ""));\n`;
      writeFileSync(probe, script, "utf8");
      const r = spawnSync("node", ["--import", "tsx", probe], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          HOME: tmpHome,
          QUIVER_AUTONOMY: "tier:operate",
          QUIVER_PROJECT_NAME: "ar-tier-probe",
        },
      });
      try {
        const ok = r.status === 0 && (r.stdout || "").includes("operate");
        if (!ok) {
          throw new Error(
            `exit=${r.status} stdout=${JSON.stringify(r.stdout || "").slice(0, 120)} stderr=${JSON.stringify((r.stderr || "").slice(0, 300))}`,
          );
        }
        return true;
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
  );

  // ─── H-7: 'unsupported' stream events must survive the adapter (behavioral) ──

  await check(
    "AR-ADAPTER-PRESERVES-UNSUPPORTED",
    "US-17.12",
    "DefaultAdapter.parseModelEvent must return type:'unsupported' for unsupported events — today the if/else chain falls through to { type:'done' }, collapsing 'unsupported'→'done' and discarding the diagnostic US-17.12 requires (and ParsedModelEvent.type has no 'unsupported' variant)",
    () => {
      const r = new DefaultAdapter().parseModelEvent({
        type: "unsupported",
        raw: { foo: "bar" },
      });
      return (r as any).type === "unsupported";
    },
  );

  // ─── C-13: update manifest must require a signature (source-text) ─────

  await check(
    "AR-UPDATE-MANIFEST-REQUIRES-SIGNATURE",
    "US-17.11",
    "fetchUpdateManifest must reject an unsigned manifest when no pubkey is configured — today verification is gated on `if (publicKey)` and DEFAULT_PUBKEY defaults to \"\", so a MITM manifest with an attacker downloadUrl is accepted with no signature check",
    () => {
      const c = codeOnly("src/updates.ts");
      // A correct fix either rejects the empty-pubkey case outright, or
      // verifies the signature unconditionally. Today neither exists.
      const rejectsEmpty = /if\s*\(\s*!\s*publicKey\b|if\s*\(\s*publicKey\s*===\s*""\s*\)/.test(
        c,
      );
      return rejectsEmpty;
    },
  );

  // ─── C-11: MCP client must not leak the full parent env (source-text) ──

  await check(
    "AR-MCP-NO-PARENT-ENV-LEAK",
    "US-16.2",
    "MCP stdio spawn must not spread process.env into the child server env — today connectStdio does `{ ...process.env, ...cfg.env }`, exposing OLLAMA_API_KEY/GITHUB_TOKEN and every Quiver secret to arbitrary third-party MCP binaries",
    () => {
      const c = codeOnly("src/mcp/client.ts");
      return !/\.\.\.\s*process\.env\b/.test(c);
    },
  );

  // ─── C-8: Electron IPC must enforce the path policy (source-text) ────

  await check(
    "AR-IPC-ENFORCES-PATH-POLICY",
    "US-8.1",
    "Each renderer-path IPC handler (preview:file, skills:save, memory:save, sessions:load) must call a path-policy guard WITHIN its own handler body — a single guard in one handler does not protect the others (the 'control present but not on the live path' defect). The renderer is driven by untrusted model output, so any unguarded handler can read ~/.ssh/id_rsa or write /etc/cron.d via traversal.",
    () => {
      const c = codeOnly("ui/main.ts");
      const guardRe =
        /\b(?:sanitizePath|assertToolPathAllowed|resolveAndAssertPathAllowed|checkPathAllowed|ipcPathGuard)\s*\(/;
      // memory:save delegates to saveMemoryFile(); a guard there counts only
      // if saveMemoryFile itself calls the guard (it does not today).
      const saveMemBody = ((): string => {
        const i = c.indexOf("async function saveMemoryFile(");
        if (i === -1) return "";
        const j = c.indexOf("\n}", i);
        return c.slice(i, j === -1 ? c.length : j + 2);
      })();
      const handlers: [string, string, boolean][] = [
        ['"preview:file"', "preview:file", false],
        ['"skills:save"', "skills:save", false],
        ['"memory:save"', "memory:save", true],
        ['"sessions:load"', "sessions:load", false],
      ];
      for (const [needle, label, delegateSaveMem] of handlers) {
        const idx = c.indexOf(`ipcMain.handle(${needle}`);
        if (idx === -1) continue; // missing handler is a separate failure
        const next = c.indexOf("ipcMain.handle(", idx + 1);
        const body = c.slice(idx, next === -1 ? c.length : next);
        const ok = guardRe.test(body) || (delegateSaveMem && guardRe.test(saveMemBody));
        if (!ok) {
          throw new Error(
            `IPC handler ${label} does not call a path-policy guard within its body — US-8.1 requires every renderer-path handler to enforce the path policy`,
          );
        }
      }
      return true;
    },
  );

  // ─── C-9: CSP must be consistent with the app's own handlers (source-text) ──

  await check(
    "AR-CSP-CONSISTENT-WITH-UI",
    "US-8.1",
    "If the renderer CSP omits 'unsafe-inline', the HTML must not use inline onclick handlers — today CSP is script-src 'self' (no 'unsafe-inline') while index.html is wired entirely with inline onclick= attributes, so either every button is dead or CSP isn't actually enforced",
    () => {
      const mainCsp = codeOnly("ui/main.ts");
      // script-src directive specifically (style-src 'unsafe-inline' is
      // irrelevant — inline event handlers are governed by script-src).
      const scriptSrcMain = mainCsp.match(/script-src[^;"'\]]*?["';,\]]/i);
      const secCsp = codeOnly("ui/security.ts");
      const scriptSrcSec = secCsp.match(/script-src[^"\]]*?"|script-src[^;"']*?;/i);
      const scriptSrcHasUnsafeInline =
        /unsafe-inline/.test(scriptSrcMain ? scriptSrcMain[0] : "") ||
        /unsafe-inline/.test(scriptSrcSec ? scriptSrcSec[0] : "");
      const indexHtml = readFileSync(path.join(ROOT, "ui/renderer/index.html"), "utf8");
      const hasInlineHandlers = /\bonclick\s*=/.test(indexHtml);
      // Consistent: inline handlers allowed (script-src unsafe-inline present)
      // OR no inline handlers (handlers moved to addEventListener).
      return !(hasInlineHandlers && !scriptSrcHasUnsafeInline);
    },
  );

  // ─── H-1: apply_patch must go through the hash read-before-write guard ──

  await check(
    "AR-APPLY-PATCH-HASH-GUARD",
    "US-6.1/US-10.1",
    "apply_patch must be subject to the same SHA-256/mtime compare-and-swap as write_file/replace_content — today the agent's centralized guard condition is `(toolName === 'write_file' || toolName === 'replace_content')` and apply_patch is excluded, so a patch can clobber a concurrently-modified file the agent never read",
    () => {
      const c = codeOnly("src/agent.ts");
      const idx = c.indexOf("verifyBeforeWrite(");
      if (idx === -1) return false;
      // The guard condition is within ~300 chars before the verifyBeforeWrite
      // call; assert apply_patch is named in that same condition.
      const window = c.slice(Math.max(0, idx - 400), idx + 40);
      return /apply_patch/.test(window);
    },
  );

  // ─── C-2: rollback failure on a rejected edit must not be swallowed ──

  await check(
    "AR-MAKER-CHECKER-ROLLBACK-NOT-SWALLOWED",
    "US-15.1",
    "On a reject/revise verdict, rollback failure must propagate — today wrapToolCall runs the tool BEFORE the checker and then does `await rollbackLast().catch(() => {})`, swallowing ENOENT/EPERM, so a rejected destructive edit can be left on disk with no record it was supposed to be blocked",
    () => {
      const c = codeOnly("src/lifecycle.ts");
      return !/rollbackLast\s*\(\s*\)\s*\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(
        c,
      );
    },
  );

  // ─── C-1: lifecycle hook errors must fail closed for security hooks ───

  await check(
    "AR-LIFECYCLE-FAIL-CLOSED-ON-THROW",
    "US-15.1",
    "A security-critical lifecycle hook (the maker-checker gate) throwing must halt execution, not be caught-and-continue — today LifecycleHookRegistry.fire() catches every hook error and returns { shortCircuit:false, abort:false }, so a transient checker failure silently skips the gate and commits the high-risk write unverified",
    () => {
      const c = codeOnly("src/lifecycle.ts");
      const fireIdx = c.indexOf("async fire(");
      if (fireIdx === -1) return false;
      // Scope to the fire() method body.
      const body = c.slice(fireIdx, fireIdx + 1600);
      // A correct fix rethrows (or aborts) on hook error instead of returning
      // a benign shortCircuit:false fallback. Today the catch returns without
      // rethrowing.
      const hasCatch = /catch\s*\(/.test(body);
      const rethrows = /catch\s*\([^)]*\)\s*\{[\s\S]*?\bthrow\b/.test(body);
      return hasCatch && rethrows;
    },
  );

  // ─── H-11: read/search/format tools must enforce the path policy ─────

  await check(
    "AR-READ-TOOLS-ENFORCE-PATH-POLICY",
    "US-9.2",
    "grep_search, glob, list_dir, format_code, office_doc, and log_tokens must call a path-policy guard — today none of them call assertToolPathAllowed/resolveAndAssertPathAllowed/checkPathAllowed (only view_file/write_file do), so the agent can grep ~/.ssh or list ~/.aws despite the spec's hard-blocked home paths",
    () => {
      const files = [
        "src/tools/grep_search.ts",
        "src/tools/glob.ts",
        "src/tools/list_dir.ts",
        "src/tools/format_code.ts",
        "src/tools/office_doc.ts",
        "src/tools/log_tokens.ts",
      ];
      return files.every((f) => {
        const c = codeOnly(f);
        return /\b(?:assertToolPathAllowed|resolveAndAssertPathAllowed|checkPathAllowed)\s*\(/.test(
          c,
        );
      });
    },
  );

  // ─── H-12: subagent scratchpad must not symlink the real node_modules ──

  await check(
    "AR-SUBAGENT-NO-REAL-NODE-MODULES",
    "US-5.3",
    "buildSubagentScratchpad must not symlink the real project node_modules into the scratchpad — today it does, so a subagent write_file to node_modules/<pkg>/index.js (or an npm install) mutates the real project's dependencies, breaking the 'cannot write to the real workspace' guarantee",
    () => {
      const a = codeOnly("src/tools/subagent.ts");
      const b = codeOnly("src/subagents/scratchpad_helpers.ts");
      const re = /symlink[\s\S]{0,120}node_modules|node_modules[\s\S]{0,120}symlink/;
      return !re.test(a) && !re.test(b);
    },
  );

  // ─── H-9: atomic write must fsync the temp file ──────────────────────

  await check(
    "AR-ATOMIC-WRITE-FSYNC",
    "US-10.2",
    "atomicWrite must fsync the temp file (and ideally the parent dir) BEFORE the rename — without it, a crash after rename returns but before the OS flushes data leaves the target zero-length/torn (metadata committed, data not). The fsync must precede fs.rename in the write path, not merely appear somewhere in the file.",
    () => {
      const c = codeOnly("src/fs/atomic_write.ts");
      const syncRe = /\bfsync\b|\bfdatasync\b|fs\.\w*[Ff]sync/;
      const renameIdx = c.indexOf("fs.rename(");
      if (renameIdx === -1) return false;
      // There must be a fsync call in the text preceding the rename.
      return syncRe.test(c.slice(0, renameIdx));
    },
  );

  // ─── H-22: facts.jsonl rewrites must be atomic ────────────────────────

  await check(
    "AR-MEMORY-FACTS-ATOMIC",
    "US-12.1/US-10.2",
    "updateMemoryFact AND deleteMemoryFact must each write facts.jsonl atomically (temp+rename via atomicWrite), not via bare fs.writeFile — a read-modify-rewrite with direct fs.writeFile means a crash mid-rewrite or one corrupt appended line wipes the whole memory store. Both mutator bodies must call atomicWrite.",
    () => {
      const c = codeOnly("src/memory/schema.ts");
      const bodyOf = (name: string): string => {
        const i = c.indexOf(`export async function ${name}(`);
        if (i === -1) return "";
        // end at the next top-level `export ` after the function start
        const j = c.indexOf("\nexport ", i + 1);
        return c.slice(i, j === -1 ? c.length : j);
      };
      const up = bodyOf("updateMemoryFact");
      const del = bodyOf("deleteMemoryFact");
      if (!up || !del) return false;
      return /\batomicWrite\b/.test(up) && /\batomicWrite\b/.test(del);
    },
  );

  // ─── H-20: session file extension must be consistent ────────────────

  await check(
    "AR-SESSION-EXTENSION-CONSISTENT",
    "US-13.1",
    "SessionManager.getFilePath()/sessionFileExists() must use the same extension that listSessions() filters for and that the live state is written with — today getFilePath uses `${id}.json`, listSessions filters `.state.json`, and agent.ts writes `.state.json`, so sessions saved by SessionManager are invisible to listSessions and every clean session is misreported as a crash",
    () => {
      const schema = codeOnly("src/session/schema.ts");
      const cp = codeOnly("src/session/checkpoint.ts");
      // getFilePath must produce .state.json (matching listSessions filter).
      const getFilePathUsesStateJson =
        /\$\{[^}]*\.sessionId[^}]*\}\s*\.state\.json|`[^`]*\$\{[^}]*\}\.state\.json`/.test(
          schema,
        ) || /\.state\.json/.test(schema);
      // sessionFileExists must use .state.json too.
      const existsUsesStateJson = /\.state\.json/.test(cp);
      return getFilePathUsesStateJson && existsUsesStateJson;
    },
  );
}