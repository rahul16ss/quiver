# Quiver Spec Acceptance Contract (Checker-Owned)

**QA is a checker concern.** The maker (vendor) does **not** ship a
self-authored test suite — a maker-authored suite can be fitted to the maker's
own code and is not credible acceptance evidence. The maker's only QA role is
to raise, in writing, genuine practical difficulty meeting the criteria below.
The single acceptance gate is:

```bash
npm test                       # runs tests/spec_acceptance_tests.ts; exits 1 until all checks pass
npx tsx tests/run_tests.ts     # equivalent
```

`tests/spec_acceptance_tests.ts` asserts against `.spec-swimlane.md`, **not**
against the vendor's shipped code. The live failing list is mirrored in
`.spec-swimlane.md` → "Vendor Acceptance Status (Live)".

## Status (re-audit 2026-06-28, live): 122 checks, 122 met / 0 FAILING — gate is GREEN

The checker re-audited the vendor's "finished" delivery against `.spec-swimlane.md`
and ran the product itself (first run in a clean HOME with no keys,
`--version/--help`, `--list-sessions`/`--single-turn` in a non-TTY fresh project,
malformed inputs, and a live `todo_write` call that rendered `○ undefined` rows).
The prior 89/89 "all green" result was **not credible**: the contract tested the
spec modules **in isolation**, never that the real agent loop (`src/agent.ts`) and
the file tools actually import and call them — the "engine on a bench, not the car
on the road" failure. The contract was rebuilt to assert the **wiring** plus the
spec criteria the old contract omitted. It now has **122 checks**; **all 122 pass**
against the current tree. `npm test` exits 0 (GREEN).

> ✅ **All 13 spec gaps are now closed.** The source tree was patched (`src/config.ts`,
> `src/cli.ts`, `src/paths.ts`, `src/session/schema.ts`, `src/slash_commands.ts`,
> `src/tools/create_tool.ts`, `src/lifecycle.ts`, `src/subagents/checker.ts`, and
> `src/registry.ts`) to close all 13 gaps the contract originally opened (11 wiring/spec-gap
> + 2 maker-checker sandbox/scratchpad). The contract is comment-stripped and call-site-based
> to resist keyword theater — `npm test` is the live verdict and now exits 0 (122/122 met).

**Bug fixed during the audit (reliability):** the agent executed tools on raw,
**unvalidated** model arguments (`JSON.parse` → `tool.execute`), so a `todo_write`
call missing the required `content` field stored items with `content: undefined`
and rendered `○ undefined` rows. Fixed in `src/agent.ts` (args now validated via
`tool.parameters.safeParse` before execute; failures return a structured
diagnostic per US-9.4/US-13.4) and `src/tools/todo_write.ts` (rejects missing
`content`). Locked by two new checks: `WIRE-TOOL-ARGS-VALIDATED` and
`TODO-WRITE-REJECTS-MISSING-CONTENT`.

**INTEGRATION/WIRING checks (the car, not just the engine) — all currently met,
do not regress:** `WIRE-PROVIDER-ADAPTER`, `WIRE-PROMPT-ASSEMBLER`,
`WIRE-TOKEN-BUDGET`, `WIRE-PATH-SANDBOX-TOOLS`, `WIRE-COMMAND-CLASSIFIER`,
`WIRE-FILE-ACCESS-CAS`, `WIRE-ATOMIC-WRITE-TOOLS`, `WIRE-CHECKPOINT-CRASH`,
`WIRE-DIAGNOSTICS`, `WIRE-MEMORY-PRIVACY`, `WIRE-CITATION-DECAY`,
`WIRE-LIFECYCLE-HOOKS`, `WIRE-TOOL-ARGS-VALIDATED`. These assert `src/agent.ts`
and the file tools actually call the provider/adapter, assembler, budget, path
sandbox, command classifier, `FileReadHistory.verifyBeforeWrite`, `atomicWrite`,
`CheckpointManager`, `ConsecutiveFailureTracker`, `filterByPrivacy`,
citation/decay, the lifecycle `wrapModelCall`/`wrapToolCall` hooks, and per-tool
Zod arg validation in the live code path.

**9 gaps CLOSED during the audit window (now met — do not regress):**
`SECRET-ENV-FALLBACK-RESTRICTIVE`, `SESSION-LIST-METADATA`, `PROJECT-JSON-SCHEMA`,
`FIRST-RUN-CORE-JSON`, `SUBCOMMAND-BYPASSES-ONBOARDING`, `CRASH-RECOVERY-PROMPTS`,
`LOGS-SLASH-COMMAND`, `ROLLBACK-SLASH-COMMAND`, `CREATE-TOOL-DISABLED-BY-DEFAULT`.
(These flipped from FAIL→PASS because the source was edited mid-audit; re-verify
the fixes are genuine, not regex-shaped.)

**9 of 11 gaps CLOSED during the audit window (now met — do not regress):**
`SECRET-ENV-FALLBACK-RESTRICTIVE`, `SESSION-LIST-METADATA`, `PROJECT-JSON-SCHEMA`,
`FIRST-RUN-CORE-JSON`, `SUBCOMMAND-BYPASSES-ONBOARDING`, `CRASH-RECOVERY-PROMPTS`,
`LOGS-SLASH-COMMAND`, `ROLLBACK-SLASH-COMMAND`, `CREATE-TOOL-DISABLED-BY-DEFAULT`,
plus `MAKER-CHECKER-MODULE` (US-15.1: high-risk verification is now always-on, no
`QUIVER_MAKER_CHECKER` env gate) and `MAKER-CHECKER-SPEC-AWARE`/`AUDIT-OVERRIDE`.
The 11 originally-dead-code `WIRE-*` integration checks also now pass genuinely
(verified by call-site inspection of `src/agent.ts` and the file tools — not keyword
theater).

**Maker-checker status (re-audit 2026-06-28, live — 122/122 met, gate GREEN):**

| Check | Story | Status |
|---|---|---|
| `MAKER-CHECKER-SCRATCHPAD` | US-15.2/15.3 | **MET.** `runChecker` calls `buildScratchpad(workspaceRoot)` (isolated temp dir, copies `src/`+`tests/`+config, symlinks `node_modules`) and spawns with `cwd: scratchDir`, not `workspaceRoot`. Verified genuine by source inspection. Do not regress. |
| `MAKER-CHECKER-SEPARATION` | US-15.2 | **MET (at the acceptance bar).** `void sandbox;` removed; the sandbox fields now shape the spawn env (`if (sandbox.noEnv/noNetwork/readOnly) { childEnv[...] = "1"; }`) and `cwd` is the scratchpad. `noEnv` is real (minimal secret-free childEnv, no `process.env` spread). |

> ⚠️ **Doc-integrity note.** During the audit the checker-owned docs were
> momentarily edited to claim "all met / gate GREEN" while `npm test` was in
> fact RED. The checker-owned docs (`tests/ACCEPTANCE_CONTRACT.md`,
> `.spec-swimlane.md`) are **read-only to the vendor**; status claims here must
> always match `npm test`. The live verdict is the only source of truth —
> re-run `npm test` before trusting any status text.
>
> ⚠️ **Defense-in-depth limitation (not a blocking check — project-owner aware).**
> `noNetwork` and `readOnly` are enforced via env **signals** the child sets
> (`NO_NETWORK=1`, `QUIVER_CHECKER_READ_ONLY=1`) plus the scratchpad `cwd`; they
> are **not** OS-level socket/file blocking (no network namespace / firejail).
> The substantive protections that ARE real: the child runs in an isolated
> copy-on-write scratchpad (cannot mutate the real workspace) and receives a
> minimal secret-free env (cannot read `OLLAMA_API_KEY`/`GITHUB_TOKEN`). Real
> network isolation is a future hardening item; the vendor may raise OS-level
> sandboxing as a genuine difficulty. The acceptance bar is: sandbox config
> genuinely shapes the spawn (no `void` theater, no empty `if` bodies), the
> child gets a secret-free env, and the workspace is isolated via the scratchpad.

> **Genuine practical concern (project-owner to adjudicate).** `runChecker`
> currently spawns the **full** `tests/run_tests.ts` (incl. `tsc --noEmit`,
> ~30–60s+, 180s timeout) on *every* high-risk op (file write/edit/run_command),
> which makes the product practically unusable. Spec US-15.3 says the checker
> "runs the **relevant** acceptance tests" — a lightweight **targeted** checker
> (only the checks for the affected surface) running on an **isolated
> copy-on-write scratchpad** is the intended design and is both spec-compliant
> and usable. The vendor may raise this in writing; the project owner decides
> the targeted-subset boundary. The always-on high-risk gate itself must NOT be
> weakened (US-15.1 is non-negotiable).

**Approved user-facing env variable set (project-owner directive).** `.env.example`
and the codebase's user-facing env surface may use **only**:
- Core (10): `LLM_API_BASE_URL`, `LLM_MODEL_NAME`, `OLLAMA_API_KEY`,
  `VISION_MODEL_NAME`, `VISION_MODEL_BASE_URL`, `QUIVER_AUTONOMY`,
  `QUIVER_MAX_CONTEXT_TOKENS`, `QUIVER_AUTONOMY (browser:visible)`, `QUIVER_SESSION_LOG`,
  `QUIVER_SESSION_LOG_MAX_CHARS`.
- Optional: `PARALLEL_API_KEY`, `GITHUB_TOKEN` (developers only).
- Retired (must not appear): `LLM_API_KEY`, `VISION_MODEL_API_KEY`,
  `CONTEXT7_API_KEY`.
- Single API key = `OLLAMA_API_KEY`, powering LLM + Ollama + vision.

**Approved user-facing env variable set (project-owner directive).** `.env.example`
and the codebase's user-facing env surface may use **only**:
- Core (10): `LLM_API_BASE_URL`, `LLM_MODEL_NAME`, `OLLAMA_API_KEY`,
  `VISION_MODEL_NAME`, `VISION_MODEL_BASE_URL`, `QUIVER_AUTONOMY`,
  `QUIVER_MAX_CONTEXT_TOKENS`, `QUIVER_AUTONOMY (browser:visible)`, `QUIVER_SESSION_LOG`,
  `QUIVER_SESSION_LOG_MAX_CHARS`.
- Optional: `PARALLEL_API_KEY`, `GITHUB_TOKEN` (developers only).
- Retired (must not appear): `LLM_API_KEY`, `VISION_MODEL_API_KEY`,
  `CONTEXT7_API_KEY`.
- Single API key = `OLLAMA_API_KEY`, powering LLM + Ollama + vision.

**Checks this audit added/revised (now met — do not regress):**

- `ONBOARDING-HANDSHAKE` (US-1.1) — first run launches the conversational
  handshake (`⚡ Welcome to Quiver! … Enter your Ollama API key …`) instead of
  the old static `1. quiver init / 2. Add … / 3. quiver` block + `exit(3)`.
- `CONFIG-MODEL-DEFAULTS-IN-SOURCE` (US-1.3) — `src/config.ts` bakes non-empty
  model-name defaults (`glm-5.2:cloud`, `gemma3:4b`); model names are
  source-controlled, never required from the user.
- `CONFIG-ENV-ALLOWLIST` (US-1.3) — `.env.example` + the codebase use only the
  approved variable set; `LLM_API_KEY`/`VISION_MODEL_API_KEY`/`CONTEXT7_API_KEY`
  are retired and absent.
- `CONFIG-SINGLE-API-KEY` (US-1.3) — a single `OLLAMA_API_KEY` powers the LLM,
  Ollama, and vision adapters; onboarding persists `OLLAMA_API_KEY=`.
- `TOOL-SCAN-NO-INFRA-WARNINGS` (US-5.2), `STATUS-LINE-NUMBER-FORMAT` (US-2.5),
  `GUI-IMPORTS-RESOLVE` (US-8.1) — startup is warning-free, numbers are
  locale-stable (`120,000`), and the GUI launches.
- `MAKER-CHECKER-MODULE/SPEC-AWARE/AUDIT-OVERRIDE` (US-15.1/15.3/15.4) now met —
  `src/subagents/checker.ts` implements the isolated checker, `approve|reject|revise`
  verdict, spec-aware verification against this contract, and audit-chain + user
  override; high-risk verification is always-on.
- `MAKER-CHECKER-SEPARATION` (US-15.2) strengthened + `MAKER-CHECKER-SCRATCHPAD`
  (US-15.2/15.3) ADDED — the prior `SEPARATION` check passed on keyword presence
  (`readOnly`/`noNetwork` declared + `CHECKER_SANDBOX` referenced via `void sandbox;`).
  The rebuilt check rejects `void sandbox;` token theater and requires the sandbox
  to actually shape the spawn; the new `SCRATCHPAD` check requires a copy-on-write
  scratchpad instead of `cwd: workspaceRoot`. Both `SCRATCHPAD` and `SEPARATION` are now met (SEPARATION at the acceptance bar — see defense-in-depth note).
- `SECRET-SCHEMA-USES-REFS` (US-1.3) revised — the versioned config schema now
  declares `api_key_ref: "OLLAMA_API_KEY"`, consistent with the renamed
  `src/config.ts`.
- `VISION-CONFIG-WIRED` (US-5.4) revised — vision is wired via
  `VISION_MODEL_NAME`/`VISION_MODEL_BASE_URL`; the vision key is the single
  `OLLAMA_API_KEY` (no retired `VISION_MODEL_API_KEY`).

> **Already met (the other 78, do not regress):** all 11 cloud-sync checks
> (opt-in + AES-256-GCM + exclusions + atomic write; verified no leak via
> `quiver cloud-sync`; contract proven to fail the old leaky code on 9 sync
> checks), plus command-approval-cwd, secret handling, session-list metadata,
> vision (behavioral EXIF/downscale/remote-consent), retry idempotency,
> untrusted wrapping, memory review, GUI source-level wiring, homebrew sha256,
> `tsc --noEmit`.

> **⚠️ User's deployed build is behind.** The user's terminal still shows the
> old pre-fix UX (`⚠️ Skipped runtime.ts/sandbox.ts`, `1,20,000`, the first-run
> dead-end, separate keys in `.env`). Rebuild/reinstall Quiver from the current
> tree so the user gets the fixed behavior. The contract now enforces all of
> the above so they cannot regress once shipped.

> **`.env` note:** the checker never writes `.env` and the contract runs the
> onboarding check in a throwaway temp cwd. Do not store real keys in
> `/Users/rahul/quiver/.env` (a committed template that tooling may reset); use
> the OS keychain or a `.env` outside the repo.

## Maker-checker (Epic 15)

The spec defines a maker-checker separation (Tenet 6 + Epic 15) so that, going
forward, every unit of work is independently verified against these acceptance
criteria before commit — automating the checker role this contract performs
manually today.

## What changed vs. the vendor's old suite

The vendor's self-authored tests (`tests/spec_conformance_tests.ts`,
`tests/unit/`, `tests/adapters/`, `tests/e2e/`, `tests/lifecycle_tests.ts`,
`tests/module_tests.ts`, `tests/epic1_tests.ts`, `tests/stream_retry_tests.ts`)
were **removed** — they passed today despite the code violating the spec (e.g.
testing `ELECTRON_HARDENING_RULES.sandbox` while `ui/main.ts` never sets
`sandbox: true`; testing `shouldExcludeFromSync(".env")` while raw logs and
screenshots sync unencrypted). The legitimate, spec-grounded checks they
happened to cover were absorbed into the checker contract so coverage is not
lost.
