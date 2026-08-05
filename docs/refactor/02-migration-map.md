# Migration Map & Test Inventory — Quiver harness refactor

## 1. Phase → deliverable → tests → removal mapping

Legend: **Add** = new module/tests, additive. **Migrate** = move callers to new
path. **Remove** = delete legacy only after equivalence passes.

| Phase | Deliverable | New tests | Legacy touched | Removal (gated) |
| :--- | :--- | :--- | :--- | :--- |
| 0 | Audit, ADRs, test inventory, migration map | — | none | — |
| 1 | Narrow interfaces, `CustomerPack` schema, `PolicyEngine`/sensitivity, `ArtifactRepository` | `01-interfaces.test.ts` (40) | none (additive) | — ✅ done |
| 2 | `ModelClient` + `QuiverOpenRouterClient` + `LocalModelClient` + `ModelProfile` + `QuiverOpenRouterProvider` bridge + native-doc contract-test scaffolding | `02-model-client.test.ts` (21) + `14-provider-bridge.test.ts` (14) + opt-in `live/run.ts` | `QuiverOpenRouterProvider` bridges ChatOpenRouter→legacy ModelProvider (ZDR-enforced); final `getActiveProvider()` flip pending | Remove `OpenAICompatibleProvider` cloud path after the flip + spec updates | ✅ adapter + bridge done; flip pending |
| 3 | `ResearchGateway` + `ParallelResearchGateway` typed ops (incl. findAll); remove regex fallback | `03-research-gateway.test.ts` (18) | `src/tools/{web_search,scrape_url}.ts` rewritten | ✅ regex `htmlToText`/`direct` fallback removed from scrape_url; ✅ Ollama Cloud web routes removed from web_search/scrape_url; deep_research/find_all/entity_search already Parallel-only | ✅ gateway + removals done; tool→SDK delegation pending |
| 4 | `ExecutionEngine` (LangGraph), `GoalContract`, gap ledger, checkpoints, approvals | `04-goal-contract.test.ts` (7), `05-execution-engine.test.ts` (12) | wrap existing tools as nodes | — | ✅ done |
| 5 | `PromptCompiler` + modular capital-markets prompt packs | `01-interfaces.test.ts` (PromptCompiler checks) | `src/prompt/assembler.ts` delegates to compiler | Remove scattered prompts after equivalence | ✅ compiler scaffold done, full packs + assembler delegation pending |
| 6 | Pinned OfficeCLI `OfficeEngine`, staging lifecycle, semantic/visual diffs, conformance corpus | `06-office-engine.test.ts` (17) | `src/tools/office_doc.ts` delegates to `OfficeEngine` | Remove direct source mutation | ✅ engine done, tool delegation pending |
| 7 | `LocalStorageProvider`, `MicrosoftGraphStorageProvider`, `GoogleDriveStorageProvider` | `07-storage-providers.test.ts` (18), opt-in `live/*` | storage ops via `StorageProvider` | — | ✅ providers done, caller wiring pending |
| 8 | Browser UI + minimal launcher/CLI | (pending) | daemon serves UI | Remove `ui/` Electron + `src/tui.ts`/`multiline.ts`/`cli_ui.ts` after equivalence | pending |
| 9 | 12 workflow capability scenarios, security hardening, packaging, docs, migration cleanup | `08-workflow-scenarios.test.ts` (97), `09-security-threats.test.ts` (17) | — | Final legacy removal | ✅ scenarios + security done; packaging/docs cleanup ongoing |

## 2. Existing test inventory (baseline, must stay green)

| File | Purpose | Status |
| :--- | :--- | :--- |
| `tests/spec_acceptance_tests.ts` | Checker-owned spec acceptance (447 checks) | green |
| `tests/e2e/tier_a_offline.ts` | Offline e2e | green |
| `tests/e2e/tier_b_officecli.ts` | OfficeCLI e2e | green |
| `tests/e2e/tier_cd_live.ts` | Live contract (opt-in) | opt-in |
| `tests/owner_verification/*` | Owner verification (command policy, electron wiring, gate credibility, maker-checker, run command) | green |
| `tests/architect_review_tests.ts` | Architect review | green |
| `tests/merged_smoke_tests.ts` | Merged smoke | green |

## 3. New test wiring

New harness tests live in `tests/harness/` and are aggregated by
`tests/harness/run.ts`, which is invoked by `tests/run_tests.ts` after the
existing spec gate. This keeps the 447-check baseline untouched and adds the
harness gate on top. A failure in either gate fails `npm test`.

CI contract tests use mocks + deterministic fixtures. Live contract tests
(`tests/harness/live/`) are opt-in via `QUIVER_LIVE_CONTRACT=1` and are skipped
by default so CI never depends on network credentials.

## 4. Equivalence criteria for each removal

- **Remove generic cloud provider:** only after `QuiverOpenRouterClient` passes
  the same streaming/tool-call/usage assertions the existing provider tests
  assert, and after `agent.ts` callers are migrated.
- **Remove regex `direct` scraping:** only after `ParallelResearchGateway.extract`
  covers the cases `scrape_url` covered, with explicit fail-closed on Parallel
  unavailability (no silent fallback).
- **Remove Electron/TUI:** only after the browser UI passes the IPC/origin/CSRF/
  loopback tests the Electron wiring tests assert, and the launcher/CLI covers
  start/stop/status/open/diagnostics.
- **Remove direct source mutation:** only after `ArtifactRepository` staging
  lifecycle passes the office_doc equivalence checks (snapshot → working copy →
  validate → commit) and existing OfficeCLI e2e still passes through the new path.

## 5. Version pinning (Phase 2 prerequisite)

Audited exact versions to pin (resolved before install):
- `@langchain/core`
- `@langchain/openrouter`
- `@langchain/langgraph`
- `parallel-web` (current official TypeScript SDK)

Pin strategy: exact versions in `package.json` (no `^`/`~`), recorded in
`docs/refactor/02-version-pins.md` after resolution, with checksums where the
publisher provides them.