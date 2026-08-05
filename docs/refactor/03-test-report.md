# Reproducible Test Report — refactor checkpoint

> Commit: `4bee75d` (on top of audit baseline `061d56e`).
> Reproduce with the commands below on Node v22 (tsx, no build step).

## Commands

| Gate | Command | Result |
| :--- | :--- | :--- |
| Type check | `npx tsc --noEmit -p tsconfig.json` | clean (exit 0) |
| Spec acceptance (checker-owned) | `npm test` | **447 / 447** pass |
| Harness gate (refactor) | `npm test` (runs after spec gate) | **84 / 84** pass (40 interfaces + 21 model + 16 research + 7 goal) |
| Offline + OfficeCLI e2e | `npm run test:e2e -- --tier=a,b` | **34 / 34** pass |
| Live contract (opt-in) | `QUIVER_LIVE_CONTRACT=1 npx tsx tests/harness/live/run.ts` | skipped by default |

`npm test` runs the spec gate then the harness gate; a failure in either fails
the command. The harness gate runs each `tests/harness/*.test.ts` as an isolated
child process via `tests/harness/run.ts`.

## Harness checks by file

| File | Checks | Covers |
| :--- | :--- | :--- |
| `01-interfaces.test.ts` | 40 | CustomerPack validation (secret-free, fail-closed MNPI, no auto-promote), hash/diff/rollback; PolicyEngine (public→OpenRouter, CI→ZDR, MNPI→local, MNPI research denied, fail-closed no-local, source-category resolution + no silent substitution); ArtifactRepository (snapshot, working copy, candidate, evidence, diff, commit-rejected-before-approval, commit-after-approval, provenance); TraceSink redaction (prompts/content/tool results redacted, model/tool names kept); PromptCompiler (7-layer order, role/goal/gap-ledger, no developer-addressing) |
| `02-model-client.test.ts` | 21 | ZDR/data_collection=deny/require_parameters/no-fallback/explicit-order/no-auto-router; MNPI refused cloud; local route; native PDF fail-closed-uncertified then certified→native engine forced + file part passthrough; DOCX fail-closed; retry-on-transient, no-retry-on-auth; strict-output only when supported; usage+route captured |
| `03-research-gateway.test.ts` | 16 | search excerpts+canonical URL+published date+retrieved-at+source category; extract full_content+excerpts+snapshot hash+objective; research (Task) content+citations; monitor; findEntities; confidential-internal query sanitization; MNPI refused; no regex scraper exported |
| `04-goal-contract.test.ts` | 7 | initial ledger (sources/deliverable/approval); partial when gaps open; completed when all pass; failed check is partial; blocked when blocked gap |

## Live contract tests (not run)

Opt-in suites present in `tests/harness/live/run.ts`, skipped in CI:

- `LIVE-OPENROUTER-NATIVE-PDF` — requires `OPENROUTER_API_KEY` + `QUIVER_LIVE_PDF`.
- `LIVE-PARALLEL-SEARCH` — requires `PARALLEL_API_KEY`.
- SharePoint/OneDrive, Google Drive, OfficeCLI live suites — added in Phases 6/7.

## Version pins

`@langchain/core@1.2.4`, `@langchain/openrouter@0.4.5`,
`@langchain/langgraph@1.4.9`, `parallel-web@1.1.0` — exact, `--save-exact`.

## npm audit

5 vulnerabilities (4 high, 1 critical) in **pre-existing transitive dev deps**
of `electron`/`puppeteer` (`tar`, `undici`, `js-yaml` via `node-gyp`). None from
the four pinned packages. `npm audit fix` is intentionally not run (would alter
pinned versions); the `electron` tree is removed in Phase 8.