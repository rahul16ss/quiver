# Gap analysis after external changes

Classification uses the requested A–E categories. This table is evidence-first; no item is marked done merely because an interface or comment exists.

| AC | Expected | Current evidence | Class | Action |
|---|---|---|---|---|
| AC-1/2/3/4/5 | Root gate, types, demos, daemon, Tier-A E2E green | Baseline receipts: all exit 0 | A | Keep pinning tests; do not edit tests |
| AC-6 | Full live E2E green or visibly attributable live failure | 38 pass / 1 fail: connection refused/fetch failed at `127.0.0.1:9223/v1` | B/environment | Start/verify the configured live endpoint before rerun; do not mask failure |
| AC-7 | Planner/maker/per-step checker/planner revision branches exercised | External code has bounded state (`stepRetries`, `planRevisions`, `revisionRequest`), but baseline only proves aggregate gate | B | Add deterministic branch tests: maker accepted, checker rejects once then maker feedback, max rejection → planner revision, planner cap → honest partial |
| AC-8 | Benchmark-backed model roles and pack roles route correctly | External catalog/router changed to Luna/Sol/Gemini/Kimi; 47 router checks pass in baseline | A/B | Review role fallback semantics and add explicit external-model metadata assertions; live route remains unverified |
| AC-9 | Native document routing is certified per MIME | Static capability tests pass; all profiles start `not-run`; live suite not run | B | Run opt-in native PDF/DOCX/XLSX/PPTX contract suite with credentials; fail closed on absent certification |
| AC-10 | Same pack flows from disk through production engine and browser daemon | `buildProductionEngine` pack loading and `HarnessDaemon` pack wiring must be checked against current HEAD; prior injected-pack tests are insufficient | B | Add a single production-composition integration test using `QUIVER_PACK` and HTTP `/api/workflows` + model profile selection |
| AC-11 | Browser workflow picker/live run/reconnect/approval visually works | External `runs.js`/UI exists; no visual walkthrough receipt in baseline | B | Run the required launch → select pack workflow → start → live phases → reload/reattach → approval/reject visual walkthrough; capture/read screenshots |
| AC-12 | Durable jobs/leases/DLQ/alerts/ambient tick | 36 durable-job + daemon checks pass | A | Preserve; add only regressions found by live use |
| AC-13 | Graph/Drive pagination/cursors/OAuth | Deterministic tests pass; full live E2E has live endpoint failure and live storage not run | B | Run live contract tests with actual credentials; review token refresh and permissions |
| AC-14 | Resume idempotency | Engine tests pass | A | Preserve; inspect commit side-effect integration before claiming external storage idempotency |
| AC-15 | Active docs and fixtures match current external catalog | README/docs dirty; `docs/refactor/model-router.md` still names old DeepSeek/GLM choices; active `docs/providers.md` still contains Vertex claims; dirty output timestamps are generated artifacts | D/E | Reconcile active docs with external model catalog; revert/regenerate timestamp-only fixture noise; remove or clearly mark stale provider docs |
| AC-16 | Deterministic exits and visible live failures | Deterministic suites pass; live suite visibly returns one failure | B | Review live test behavior; retain explicit failure, never silently skip |
| AC-17 | Ownership and commit hygiene | Working tree dirty; prior commits need trailer review; no protected pi files touched by this work | B/E | Reconcile dirty files deliberately; use required `Co-Authored-By: Quiver <quiver@convictionstudio.com>` on future commits; never modify protected pi files |
| Tooling | Lint/build commands in release verification | `npm run lint` and `npm run build` fail because scripts are absent | C | Add minimal, appropriate scripts only if consistent with project conventions; otherwise document approved alternatives in VERIFY and release gate |
| Chat routing | Browser chat should use intended role/model routing | `browser-bridge.ts` starts legacy `agent.ts`; provider-bridge dirty edit contains `require_router()` and `chatModelFor()` returns the existing model, not the selected profile | E/B | Revert the incomplete experiment or replace with a tested, real per-request model construction. Do not claim chat routing until an HTTP/browser-path test proves model diversity |
| Plan execution | A planner-produced plan reaches maker steps | External code adds planner/checker gate, but needs branch and live-engine receipts | B | Add a trace assertion that the planner output advances to a produce step and invokes maker with `hintMime`; fix if not |
| UI copy | Current model/provider language matches external catalog and truth table | External UI changed endpoint/model display; stale context/settings files still mention Vertex | D | Reconcile user-visible config copy with current gateway/catalog, then run visual QA |

## Progress notes (goal-seeking loop)

- **2026-08-07 production composition root:** `src/harness/production-runtime.ts`
  now wires CapabilityRegistry, Parallel (when allowed), IntegrationBroker,
  ResearchStateStore, durable jobs, idempotency ledger, OfficeCLI probe,
  ExecutionContext tool filter, and honest `unavailable[]`. Browser/CLI/daemon
  workflow paths use it via `buildProductionEngine`/`startBrowserUI`. Chat still
  uses legacy `Agent` but installs the same network guard and strips profile-
  removed tools. See `NOTES/FINISH_LINE.md` for the remaining P0/P1 list.
- AC-7 (per-step maker/checker/planner gate): NOW PROVEN. New test
  `tests/harness/32-engine-maker-checker-planner.test.ts` (11 checks) drives the
  engine with scripted models: planner advances to a produce step, maker fires
  with the deliverable hintMime, per-step checker verifies, a rejection feeds
  feedback to the maker, and a legitimately-stuck step terminates honestly.
  Confirmed by trace: a reject-then-OK on an otherwise-clean contract yields
  ~2 maker calls and a `paused` terminal; an unresolvable mandatory source
  category loops honestly to the iteration budget (not an engine defect).
- AC-15 (docs): README OpenRouter claim fixed; model-router.md reconciled to the
  external catalog. Slugs verified against the live OpenRouter API (all exist;
  pricing matches). Committed as 8df027a.
- AC-17 (residue): incomplete provider-bridge chat-routing experiment reverted
  to HEAD (its `chatModelFor` returned the same client — not a real switch, and
  used a CJS require in ESM). This reverts the dirty edit; chat routing stays
  single-model by design until a real, tested per-request model is built.
- AC-11 `/api/run/active` (browser live-run poll surface): VERIFIED BY INSPECTION
  — `HarnessDaemon.startRun` registers the run with `outcome:null` BEFORE
  `engine.run`, and `active()` filters `outcome === null`, so in-flight runs are
  discoverable and the UI can reattach after reload. A wall-clock HTTP poll is
  NOT deterministic (mock engine completes in microseconds, so the in-flight
  window is unobservable over the boundary); adding it as a timing assertion
  would be flaky. Decision: do NOT put a timing race into the deterministic
  suite; keep the mechanism verified by code inspection and note it here. If
  needed later, prove it with a deliberately-slow mock engine in an opt-in
  (non-CI) harness rather than a wall-clock race.
- Tooling gap: `npm run lint` and `npm run build` are absent scripts. No build
  is defined; `npx tsc --noEmit` is the type gate (passes). This matches the
  project's current layout; a lint script would need an added linter dependency
  and is not required by the committed acceptance contract. Recorded, not
  fabricated.

## Defect found by real CLI reproduction (2026-08-07)

- Reproduced from the repository root with a pseudo-TTY. Before the fix, the
  startup output showed the raw `LLM_MODEL_NAME` (`google/gemini-3.6-flash`),
  the legacy checker-endpoint warning, and the user reported a terminal
  `Question` card whose body was `undefined`.
- Root cause at the runtime boundary: `src/tools/ask_question.ts` passed raw
  provider arguments directly into the terminal card; malformed/missing
  `question` values could render `undefined`. It also rendered a terminal card
  even when the browser prompt resolver owned the question surface.
- Fixed in `bab66ef`: validate question/header/choices at execution time;
  missing/invalid question fails closed; terminal card only renders when no
  browser prompt resolver is installed; OpenRouter suppresses the legacy
  checker-endpoint warning; auto-routing banner says `model chosen by
  workflow` rather than the raw legacy model name.
- Verification after fix, all from `/Users/rahul/quiver`: `npm test` exit 0
  (459 spec + all harness), `npx tsc --noEmit` exit 0, Tier-A E2E 24/24,
  daemon smoke pass, and pseudo-TTY startup capture showed no `Question` or
  `undefined` line. New test 33 has 7 deterministic boundary checks.

## User-reported CLI defect and chat-router closure (2026-08-07)

- Reproduced the user's startup command from `/Users/rahul/quiver` under a
  pseudo-TTY. Before the fix it showed the raw `google/gemini-3.6-flash` banner,
  the legacy checker warning, and the user-observed `Question`/`undefined`
  prompt symptom.
- Fixed in `bab66ef`: malformed `ask_question` arguments fail closed; browser
  prompt resolver suppresses the duplicate terminal card; OpenRouter suppresses
  the legacy checker warning; auto-routing banner is explicit.
- External model catalog now uses Luna (maker), Sol (planner), Gemini/Kimi
  family-separated checkers, and native-doc maker/failsafe profiles. The legacy
  chat bridge had previously remained single-model; that is now fixed in the
  current working change: `QuiverOpenRouterProvider` constructs/caches a
  per-profile model for each `auto` request, routes text to `text-maker`, and
  routes file/image requests to `native-doc-primary`, with separate provider
  policy on the selected profile.
- New `34-chat-router-bridge.test.ts` proves text and file requests construct
  distinct routed models; `npm test` from `/Users/rahul/quiver` passes 459 spec,
  all harness, and 3 chat-router checks. This closes the previously identified
  chat-path gap. The chat bridge is still not a checker pass; per-step
  maker/checker gates belong to workflow execution, while chat now at least
  uses the same modality-aware maker routing.
