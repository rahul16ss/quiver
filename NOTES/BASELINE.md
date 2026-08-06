# Re-baseline after external changes

Date: 2026-08-07
Repository: `/Users/rahul/quiver`
Branch: `main`
HEAD: `9f7810e` (`feat(browser-ui): pack workflow picker, live run surface, ambient connection state`)
Remote relation: `main...origin/main [ahead 33]`

## Baseline / ownership

My last Quiver contribution before the external work was `85c0c38` (`feat(harness): maker/checker/PLANNER separation + multimodal-vs-text routing`). The external delta is the committed range `85c0c38..HEAD`:

| Commit | Summary | Files principally affected |
|---|---|---|
| `d4fec96` | Benchmark-backed model reselection and native-document checker-family split. Adds planner, native-document checker, and changes text maker/checker choices. | `src/harness/model-profile.ts`, `src/harness/model-router.ts`, `packs/conviction-studio-default/pack.json`, router tests |
| `b8e95c1` | Per-step maker/checker gate with bounded planner escalation and plan-revision state. | `src/harness/execution-engine.ts` |
| `9f7810e` | Pack workflow picker, live workflow run surface, active-run reattachment, ambient connection state. | `src/harness/harness-daemon.ts`, `src/harness/ui/{app,index,styles}.js/html/css`, `src/harness/ui/js/{bridge,chat,context,runs,wire}.js` |

External range file list:

- `packs/conviction-studio-default/pack.json`
- `src/harness/execution-engine.ts`
- `src/harness/harness-daemon.ts`
- `src/harness/model-profile.ts`
- `src/harness/model-router.ts`
- `src/harness/ui/app.js`
- `src/harness/ui/index.html`
- `src/harness/ui/js/bridge.js`
- `src/harness/ui/js/chat.js`
- `src/harness/ui/js/context.js`
- `src/harness/ui/js/runs.js` (new)
- `src/harness/ui/js/wire.js`
- `src/harness/ui/styles.css`
- `tests/harness/25-model-router.test.ts`

No files were deleted in the external range. The external changes replaced the earlier DeepSeek/GLM default routing with benchmark-backed Luna/Sol/Gemini/Kimi family-separated roles and replaced the earlier single plan/check loop with bounded per-step maker/checker rejection and planner revision state. The browser UI now exposes pack-gated workflows and live run/approval state.

## Working-tree changes not in HEAD

These are present before the new verification work and are not attributed to the external commit range:

- `README.md` — local documentation edits, including the OpenRouter/Vertex wording change.
- `docs/refactor/model-router.md` — local router documentation edits.
- `src/harness/provider-bridge.ts` — an unfinished local chat-path routing experiment; it uses a `require_router()` workaround and its `chatModelFor()` currently does not construct/use the selected model correctly. This is a candidate for revert or a proper fix; it must not be treated as verified.
- `workflow-packs/research/post-earnings-evidence-pack/expected-output/Post_Earnings_Run_Record.json` — dirty fixture output; origin and correctness to be verified before preserving.
- `workflow-packs/wealth/portfolio-review-pack/expected-output/Portfolio_Review_Run_Record.json` — dirty fixture output; origin and correctness to be verified before preserving.

No stash entries exist. No pi files are being modified. The externally owned pi files named by the user (`sdk.ts`, `settings-manager.ts`, `agent-session.ts`, and `~/.pi/agent/settings.json`) are out of scope and will remain untouched.

## Authoritative goal assumption

The authoritative goal is the user's original Quiver refactor brief and the current repository acceptance gates: a production-grade, customer-configurable capital-markets harness with real maker/checker/planner execution, native-document/text model routing, durable/resumable workflows, pack-driven browser UX, storage/OAuth safety, and honest deterministic tests. External changes are treated as authoritative starting point and will be preserved unless a verification result proves a regression or an explicit user decision changes them.
