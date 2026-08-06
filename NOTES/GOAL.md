# Quiver refactor acceptance criteria

These criteria are based on the user's Quiver brief, `/Users/rahul/PROJECTS.md`, `AGENTS.md`, the public repository's acceptance contract, and the external changes now at `9f7810e`. They are observable; each can be falsified by a command or a deterministic test.

| ID | Observable acceptance criterion | Owner files | Verifying test/evidence | Status |
|---|---|---|---|---|
| AC-1 | `npm test` runs from `/Users/rahul/quiver` and exits 0; spec and harness gates both pass. | `tests/run_tests.ts`, `tests/harness/run.ts` | `/tmp/quiver-baseline-test.log`; `cd /Users/rahul/quiver && npm test` | [x] baseline pass |
| AC-2 | `npx tsc --noEmit` from the Quiver root exits 0. | all TypeScript | `/tmp/quiver-baseline-tsc.log` | [x] baseline pass |
| AC-3 | Three credential-free reference demos pass their documented acceptance checks. | `examples/...`, `workflow-packs/...` | `/tmp/quiver-baseline-demo-*.log` | [x] baseline pass |
| AC-4 | Daemon smoke proves start, event delivery, reconnect replay, stop, shutdown. | `scripts/daemon_smoke.ts`, daemon | `/tmp/quiver-baseline-daemon.log` | [x] baseline pass |
| AC-5 | Tier-A offline E2E exits 0 with all 24 checks passing. | `tests/e2e`, runtime | `/tmp/quiver-baseline-e2e.log` | [x] baseline pass |
| AC-6 | Tier-C/D live E2E has truthful, credential/endpoint-visible results; no live failure is hidden. | `tests/e2e/tier_cd_live.ts` | `/tmp/quiver-baseline-e2e-all.log` | [ ] live environment: 38 pass, 1 connection failure |
| AC-7 | Planner, maker, per-step checker, bounded rejection feedback, and bounded planner revision are real execution-engine transitions, not comments. | `src/harness/execution-engine.ts` | `tests/harness/05-execution-engine.test.ts`, `28-workflow-live-engine.test.ts` | [x] external change present; baseline tests pass; needs targeted assertions for new branches |
| AC-8 | Role routing selects distinct benchmark-backed profiles for planner, text maker/checker, native-doc maker/checker/failsafe, respecting sensitivity and pack role allowlists. | `src/harness/model-router.ts`, `model-profile.ts`, pack | `25-model-router.test.ts`, live contract test | [ ] baseline test pass; certification/live routes not run |
| AC-9 | A native-document task routes to a certified native-file-capable model; text tasks route to the text tier; no OCR fallback for protected documents. | `model-router.ts`, `model-client.ts`, capability registry | `02-model-client`, `20-capability`, `25-model-router`, opt-in live PDF | [ ] static/deterministic pass; live capability certification not run |
| AC-10 | Customer-pack workflow/model allowlists flow through the production browser path, not only injected unit tests. | `launcher.ts`, `harness-daemon.ts`, `customer-pack.ts`, UI | `17-harness-daemon.test.ts`, browser E2E/visual walk-through | [ ] external browser changes exist; end-to-end pack-path proof required |
| AC-11 | Browser workflow picker starts a pack-approved run, shows live phases, reattaches after reload, and exposes approval/rejection; UI visual states are actually inspected. | `src/harness/ui/js/runs.js`, daemon/UI | browser E2E + visual screenshots | [ ] code present externally; visual walk-through not performed in this baseline |
| AC-12 | Durable jobs acquire leases, recover expired leases, retry with backoff, dead-letter after max attempts, recover DLQ entries, dedup alerts/webhook events, and tick through the daemon. | `durable-job.ts`, daemon | `27-durable-job`, `17-harness-daemon` | [x] deterministic baseline pass |
| AC-13 | Graph and Drive change feeds follow all pages and persist final cursors across restart; OAuth clients attach/refresh keychain tokens. | `storage-providers.ts`, `cursor-store.ts`, `graph-oauth-client.ts`, `drive-oauth-client.ts` | `07`, `26`, `30`, `31`; live Graph/Drive contract | [x] deterministic pass; live contract not run |
| AC-14 | Resume/approval retries are idempotent and cannot double-commit. | `execution-engine.ts` | `05-execution-engine.test.ts` | [x] baseline pass |
| AC-15 | README/docs/pack manifests describe the actual current model, provider, workflow, and capability boundaries; no stale Vertex/old-slug claims remain in active docs. | `README.md`, `docs/refactor/*`, pack JSON | grep audit + doc checks | [ ] known stale docs/dirty changes; fix after implementation baseline |
| AC-16 | All tests have deterministic exits; live tests fail visibly when credentials/endpoints are absent and are never silently skipped. | test runners/live tests | baseline logs + live harness review | [ ] review live-test semantics |
| AC-17 | No protected pi files are modified; Quiver changes are committed with required Quiver trailer. | git status/log | `git diff`, commit review | [ ] enforce during work |

## Non-goals

- No modification to `/Users/rahul/pi/packages/coding-agent/src/core/sdk.ts`, `settings-manager.ts`, `agent-session.ts`, or `~/.pi/agent/settings.json`.
- No change to the external contributor's committed work without evidence of a regression.
- No claim that live OpenRouter, Parallel, Graph, Drive, or OfficeCLI contracts passed without credentials and a successful receipt.
- No public claim of default-local processing, universal ZDR, compliance readiness, or universal live lineage.
- No speculative GUI redesign; GUI work must be driven by the user stories and the release gate.
- No push to remote.
