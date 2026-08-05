# Migration Map & Test Inventory — Quiver harness refactor

## 1. Phase → deliverable → tests → removal mapping

Legend: **Add** = new module/tests, additive. **Migrate** = move callers to new
path. **Remove** = delete legacy only after equivalence passes.

| Phase | Deliverable | New tests | Legacy touched | Removal (gated) |
| :--- | :--- | :--- | :--- | :--- |
| 0 | Audit, ADRs, test inventory, migration map | — | none | — |
| 1 | Narrow interfaces, `CustomerPack` schema, `PolicyEngine`/sensitivity, `ArtifactRepository` | `tests/harness/01-interfaces.test.ts`, `02-customer-pack.test.ts`, `03-policy-engine.test.ts`, `04-artifact-repository.test.ts` | none (additive) | — |
| 2 | `ModelClient` + `QuiverOpenRouterClient` + `LocalModelClient` + `ModelProfile` + native-doc contract-test scaffolding | `05-model-client.test.ts`, `06-model-profile.test.ts`, opt-in `live/openrouter-native-pdf.test.ts` | none yet | Remove `OpenAICompatibleProvider` cloud path + Ollama cloud route after equivalence |
| 3 | `ResearchGateway` + `ParallelResearchGateway` typed ops; remove regex fallback | `07-research-gateway.test.ts` | `src/tools/{web_search,scrape_url,deep_research}.ts` migrated to gateway | Remove `htmlToText` regex + `direct` fallback + Ollama cloud web routes |
| 4 | `ExecutionEngine` (LangGraph), `GoalContract`, gap ledger, checkpoints, approvals | `08-goal-contract.test.ts`, `09-execution-engine.test.ts` | wrap existing tools as nodes | — |
| 5 | `PromptCompiler` + modular capital-markets prompt packs | `10-prompt-compiler.test.ts` | `src/prompt/assembler.ts` delegates to compiler | Remove scattered prompts after equivalence |
| 6 | Pinned OfficeCLI `OfficeEngine`, staging lifecycle, semantic/visual diffs, conformance corpus | `11-office-engine.test.ts`, `12-conformance-corpus.test.ts` | `src/tools/office_doc.ts` delegates to `OfficeEngine` | Remove direct source mutation |
| 7 | `LocalStorageProvider`, `MicrosoftGraphStorageProvider`, `GoogleDriveStorageProvider` | `13-storage-local.test.ts`, opt-in `live/graph.test.ts`, `live/gdrive.test.ts` | storage ops via `StorageProvider` | — |
| 8 | Browser UI + minimal launcher/CLI | `14-browser-ui.test.ts`, `15-launcher-cli.test.ts` | daemon serves UI | Remove `ui/` Electron + `src/tui.ts`/`multiline.ts`/`cli_ui.ts` after equivalence |
| 9 | 12 workflow capability scenarios, security hardening, packaging, docs, migration cleanup | `16-workflow-scenarios.test.ts`, `17-security-threats.test.ts` | — | Final legacy removal |

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