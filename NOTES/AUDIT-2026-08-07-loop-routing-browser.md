# Quiver audit — loop system · pareto model routing · browser interface

**Date:** 2026-08-07 · **Scope:** purpose-fit for Conviction Studio engagements (per PROJECTS.md §0 first-customer mode)
**Method:** three parallel code sweeps (loop/orchestration, routing/file-handling, browser UI/daemon) + PROJECTS.md/SPEC §19/user-stories.md + external research on native-file model APIs (Anthropic/OpenAI/Gemini file inputs, OpenRouter file parts & pdf engines).

---

## Verdict

Quiver's trust core is real and unusually honest: a genuinely fail-closed checker (zero checks ⇒ reject, unavailable checker ⇒ reject), rollback on rejected mutations, a hash-chained audit trail, a sandboxed verification scratchpad, and a browser surface whose security posture (loopback + timing-safe secret + strict CSP + traversal guards) is stronger than most commercial local apps. The demo story is credible and cannot fail in a sales call by design.

The gap is not trust — it is that **the product is split into two control planes, and the buyer lives on the wrong one.** Interactive chat (the surface a client touches most) runs on the legacy agent with none of the harness's model routing, capability certification, or cost governance. Meanwhile the harness plane, which has all of that, cannot ingest a single client file today because its per-MIME certification gate has never been run and its model catalog is speculative. The browser build also cannot save configuration at all (dead Settings, broken onboarding) — a first-run dead end that violates the repo's own "zero dead elements" rule and would surface in the first minute of a hands-on pilot.

None of this requires new invention. The highest-value work is wiring together things that already exist.

---

## A. Loop system

**What's right (keep, and say so in diligence):**

- One verification primitive (`runChecker`) fired per-change (`lifecycle.ts` maker-checker gate on high-risk tools) and at completion (`ambient.ts`, ≤5 heal rounds). Deterministic + model verdicts must _both_ approve. Zero checks ran ⇒ reject. Checker unavailable ⇒ reject. (`checker.ts:521-541`)
- Rejected destructive edits roll back, and a rollback failure _propagates_ (`lifecycle.ts:469`).
- Tamper-evident audit chain (`audit_chain.ts`), read-before-write CAS guard, first-writer-wins finishReason, truncation auto-continue, compaction behind a consent gate.

**Findings (ranked):**

1. **A-1 · Document-only turns skip the completion gate.** `mutatedThisTurn` is set only for `write_file/replace_content/apply_patch` (`agent.ts:3324`) — not `office_doc` mutations. So a turn that only builds the deliverable (the flagship act of this product) never triggers the ambient verify/heal loop; it relies solely on the per-change gate. The completion self-heal should treat document mutations as mutations.
2. **A-2 · No dollar budget on the interactive loop.** `CostLedger.checkBudget` is a hard pre-call gate — but only on the harness `model-client.ts` path with an `engagementId` + cap. `agent.ts` streams via `getActiveProvider()` directly: chat spend is uncapped and unrecorded. For a services business, per-engagement spend attribution is margin arithmetic, not telemetry.
3. **A-3 · Workflow-level human approval is scaffold.** `RunStatus:"paused"` is defined but never set; `executeWorkflow` runs all six phases straight through; `ReviewManager` (analyst→VP→IC chain) is a decoupled data structure never invoked from the run loop. The _interactive_ approval/consent gates are real — but the product story ("a senior signs the document") has no in-run stop-and-wait between build and handover.
4. **A-4 · Two schedulers, unequal durability.** `harness/durable-job.ts` (SQLite/WAL, leases, dead-letter, catches up missed runs) is solid; legacy `workflow/scheduler.ts` (JSON, 60s tick) silently skips runs missed while the daemon was off — exactly the "close Friday, open Monday" scenario Dana's persona depends on. Consolidate on the durable layer.
5. **A-5 · Resume is phase-granular only.** A crash mid-`build` redoes the whole phase; no in-orchestrator phase retry. Acceptable for fixture demos; a live multi-hour drafting phase will feel it.
6. **A-6 · Loop guards are pathological-only.** `maxLoops = 1000` catches runaway, nothing else; the real stop discipline lives in the checker + ambient budget (good), but there is no per-run token/cost ceiling on chat (see A-2).

## B. Pareto model routing + native files

**What's right:** `ModalityRouter` is a clean pure function (sensitivity → measured Pareto winner → native-file modality → cheap text tier), fails closed for MNPI, deliberately separates maker/checker model _families_, and `routing-eval.ts` computes a measured non-dominated frontier per (role, modality) — a more principled pareto design than hand-tuned tables. ZDR prefs are pinned per request (`allow_fallbacks:false, data_collection:"deny", zdr:true`).

**Findings (ranked):**

1. **B-1 · The buyer's plane bypasses the router entirely.** Browser chat delegates to legacy `agent.prompt` (`browser-bridge.ts:181`): no ModalityRouter, no profiles, no certification, no cost ledger, no measured routing. Everything sophisticated governs only workflow runs. "Full chat→engine unification remains deferred" (`launcher.ts:222-226`) — this deferral is now the single most consequential architecture item in the repo.
2. **B-2 · Native-file ingestion is built but locked.** The mechanism the owner wants exists end-to-end: `file_encoder.ts` → OpenRouter `file` parts (magic-byte validation, 20MB cap, EXIF-stripped images), PDFs forcing `pdf.engine:"native"`. But on the harness plane `isCertifiedFor()` throws for every MIME because every shipped profile has `testedNativeMimeTypes: []` / `lastContractTest: not-run`. The gate design is right (never silently substitute OCR); the certification suite has simply never been executed. Run it.
3. **B-3 · The shipped model catalog is fiction until verified.** `starterCatalog()` cites "live OpenRouter data Aug 2026" for model IDs and prices that were never tested. Measured routing evidence (`~/.quiver/routing-evidence.json`) is empty. Pareto routing that has never measured anything is a spec, not a router. Seed it: run `routing-eval.ts` against the real OpenRouter catalog, then let `measuredPreference` (quality ≥0.8 within 3× cheapest) actually pick.
4. **B-4 · Native-file routing policy should be per-format, not binary.** External reality (verified Aug 2026): PDFs are natively consumed by Anthropic/OpenAI/Gemini; OpenAI runs a spreadsheet-specific augmentation for XLSX; Anthropic XLSX needs its analysis tool; OpenRouter offers native pass-through vs `mistral-ocr` ($2/1k pages) vs free markdown conversion, plus **file annotations** that avoid re-parsing the same document on every turn (unused by Quiver today — a real cost/latency lever for multi-turn work over a data room). Recommended routing dimension per format:
   - **PDF prose** (filings, CIMs, transcripts): native file part to a certified native-doc profile; scanned/image-only → declared OCR fallback, never silent.
   - **XLSX**: _deterministic OfficeCLI structured reads are the right primary_ — cell-accurate, lineage-recordable, cheaper than any native path; native/vision only for layout questions. For a product whose promise is "every number traceable," model-eyes-on-a-spreadsheet is the weaker evidence.
   - **DOCX/PPTX**: OfficeCLI extraction primary, native part when full-document comprehension is the task.
     Cache parsed representations via OpenRouter annotations keyed by content hash.
5. **B-5 · Config/doc drift:** "Vertex BYOK" is gone (`vertex_auth.ts:11`) but the name survives, and `.quiver/sensitivity.json` still routes to `vertex:google/gemini-2.5-pro` — a stale endpoint in the _sensitivity_ path (it fails closed, but a refusal at demo time is still a demo failure). Clean both.
6. **B-6 · Cost numbers are floor estimates.** Provider-omitted costs record as 0; `log_tokens` is ~4 chars/token heuristic; chat spend invisible (A-2). Fine internally; never quote these to a client as spend truth until B-1/A-2 land.

## C. Browser interface

**What's right:** daemon security (loopback bind, Host + Origin checks, timing-safe header-only secret, fragment token delivery, CSP `script-src 'self'`, traversal guard); the three planes and five screens exist; consent gate/approval-with-diff/lineage chips → verification rail/mark-final-blocked-by-open-flags are **real and wired**; SSE with history replay; honest empty/loading/reconnect states in most surfaces.

**Findings (ranked):**

1. **C-1 · Config cannot be saved. At all.** Settings button → `loadSettings()` no-op; nothing links `settings.html`; onboarding "Get started" and Settings "Save" POST `/api/config/save`, which has **no server handler** — and unknown routes return HTTP 200 with `{error}`, so the UI can't even tell it failed. First-run users can dead-end on an empty index (hash set, no router). This breaks S2/S13/S16 and the zero-dead-elements rule, and it is precisely the class of defect incident-lesson #1 warns about ("tests green ≠ working product").
2. **C-2 · The GUI QA harness tests a ghost.** `tests/gui_*_qa.mjs` launch the _removed_ Electron binary; the visual walkthrough on the current UI is an open release-gate item per SPEC §19 itself. Until the QA method targets the daemon UI, every release re-risks C-1-class defects.
3. **C-3 · Buyer-language violations:** "(API key)" in the onboarding placeholder, "endpoint" in settings help — the two words the Apple-grade rule bans by name.
4. **C-4 · Defense-in-depth gaps:** markdown renderer emits unsanitized `href` (a `javascript:` link survives escaping; CSP mitigates), `img/iframe src` interpolated unescaped in preview, overlays lack `role="dialog"`/`aria-modal`/focus trap, trust pill is a non-focusable `<div>`.
5. **C-5 · Two execution paths behind one window:** chat (legacy Agent) vs workflow runs (ExecutionEngine) means the activity plane, cost story, and routing behavior differ by which box the user typed into — invisible today, but it will produce "why did it behave differently" moments in a pilot (same root cause as B-1).

## D. Purpose-fit for Conviction Studio — the Steve Jobs read

The demo is the product right now, and it is _good_: deterministic, honest, inspectable, climaxing at the deliverable moment. Don't touch it.

But the first paid engagement is not a demo. Per PROJECTS.md's own flagship job ("turn an IC template, model, diligence material… into a reviewable first-pass IC memo"), the sprint requires exactly four things Quiver cannot do yet:

1. **Eat the client's real documents** → B-2 (run certification) + B-4 (per-format policy). Today a data-room PDF works on the ungoverned chat plane and throws on the governed one.
2. **Prove numbers live, not just in the fixture** → the live `EvidenceTracker.validateEvidence()` checks that claims have approved sources but never re-reads a workbook cell; cell-level verification exists only in the flagship example's acceptance checks. The engagement promise ("every number traceable") needs the cell re-read in the live loop for Excel-sourced claims.
3. **Let the senior actually gate delivery in a run** → A-3 (wire `paused` + ReviewManager into `executeWorkflow`); the UI's mark-final rail already provides the surface.
4. **Report what it cost** → A-2/B-6 (every model call through the ledger with an engagementId).

Equally important — what **not** to do (§0 discipline): no new workflow packs (11 scaffolds is already inventory, not product), no fan-out engine, no dark theme, no second flagship, no framework rewrite of the UI, no new connectors before a client names one. The two-plane unification should be approached as _retiring the legacy chat path onto the engine_, not as a rewrite project.

---

## Prioritized actions

**P0 — production defects / demo blockers (build-trigger #1/#2; do before scaled outreach):**

1. Implement `/api/config/save` + fix Settings/onboarding navigation; make unknown API routes return non-200. (C-1)
2. Point the GUI QA scripts at the daemon UI and run the visual walkthrough release gate once end-to-end. (C-2)
3. Remove the stale `vertex:` endpoint from `.quiver/sensitivity.json`; rename/retire `vertex_auth.ts`. (B-5)
4. Fix the two buyer-language strings. (C-3)

**P1 — first-engagement prerequisites (build-trigger #4 the moment a diagnostic is signed; prepare now, ship against the engagement):** 5. Run the native-file certification suite against the real OpenRouter catalog; replace the speculative `starterCatalog()` with verified profiles; seed `routing-evidence.json` via `routing-eval.ts`. (B-2, B-3) 6. Route every model call — chat included — through `QuiverOpenRouterClient` + `CostLedger` with an engagement id (kills A-2/B-1/B-6/C-5 with one unification; the deferral note in `launcher.ts` is the work order). 7. Treat `office_doc` mutations as mutations for the ambient completion gate. (A-1) 8. Live Excel cell re-read in `validateEvidence()` for `excel_cell` sources. (D-2) 9. Wire `paused` + ReviewManager into `executeWorkflow`, surfaced through the existing mark-final rail. (A-3) 10. Adopt the per-format ingestion policy + OpenRouter annotation caching. (B-4)

**P2 — deferred until discovery evidence demands them:**
Durable-job consolidation of the legacy cron scheduler (A-4) · intra-phase checkpointing (A-5) · markdown href sanitization + dialog a11y + focusable trust pill (C-4) · chat-plane per-run token/cost ceilings beyond the ledger (A-6).

**Standing risk to log:** SPEC §19 calls the browser UI a "shipped foundation" while its Settings screen is unreachable — the status table is ahead of reality on Epic 2. Correct §19 when P0-1 lands (the doc's own maintenance rule: fix disagreements before doing anything else).

---

## Remediation addendum — 2026-08-07 (same day)

**Fixed and verified (all gates green: npm test, tsc, demo:ic-memo, GUI QA 12/12):**

- P0-1..4 complete: `/api/config/save` + `/api/config/setCredential` (keychain-only secrets, allowlisted env keys, 0600), real Settings/onboarding navigation with fragment-token preservation, 404 on unknown API routes, buyer-language fixes, stale vertex descriptor removed, GUI QA rewritten against the daemon UI (`tests/gui_browser_qa.mjs`; also caught + fixed a live null-deref in `model.js`).
- C-4: markdown `href` scheme allowlist, DOM-built preview embeds, keyboard-accessible trust pill, `aria-label` on close buttons (overlays already had role/aria-modal/focus-trap).
- A-1: `office_doc` mutations now set `mutatedThisTurn` — document-only turns trigger the ambient completion gate.
- D-2: `validateEvidence()` re-reads declared `excel_cell`/`excel_derived` cells via officecli in the live loop; relative paths resolve against the Evidence.json directory; unrunnable reads are failures (never passes).
- A-3: legacy orchestrator pauses after `verify` when the workflow declares a `review_role` (creates the ReviewManager chain, `workflow:paused` event); resume refuses until the review is approved.
- A-2/B-6 (partial): chat plane requests usage accounting (`stream_options.include_usage`; OpenRouter `usage.include` → real `costUsd`) and records every turn to the shared `~/.quiver/cost-ledger.jsonl` as `chat:<workspace>`.
- B-2/B-3 infrastructure: certification persistence (`~/.quiver/native-certifications.json`, latest-wins, model-swap invalidation, loaded by `buildProductionRuntime`) + live contract-test runner (`scripts/run_native_contract_tests.ts`, code-word round-trip, same wire shape as the client). All catalog slugs verified to exist on OpenRouter (the catalog is real, not fictional).

**Blocked on owner (key limit):** the live certification run and `QUIVER_LIVE_EVAL=1` routing eval both 403 — the OpenRouter key's $300 total limit is exhausted. Raise/remove at openrouter.ai/settings/keys, then run:
`npx tsx scripts/run_native_contract_tests.ts` and `QUIVER_LIVE_EVAL=1 npx tsx scripts/run_routing_eval.ts`.

**New finding from the live run (B-7):** with `zdr: true` pinned, OpenRouter returns _no endpoints_ for `anthropic/*` and `openai/*` models (404), while Google/Moonshot pass endpoint resolution. As shipped, the ZDR promise silently excludes Anthropic/OpenAI from the harness plane entirely; kimi-k3's real providers (Fireworks/BaseTen/DigitalOcean/…) also don't match a "Moonshot" providerOrder. Decide: keep the hard ZDR pin and prune those profiles honestly, or introduce an explicit per-engagement `zdr: "required" | "preferred"` posture. Do not soften silently.

**Still open (deferred deliberately):** B-1/C-5 chat→engine unification; B-4 per-format ingestion policy + OpenRouter annotation caching; A-4 scheduler consolidation; A-5 intra-phase checkpoints.
