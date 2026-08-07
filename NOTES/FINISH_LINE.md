# Finish-line status — Quiver production refactor

Date: 2026-08-07 (updated after finish-line push)
Audience: next editor / owner.

Hostile, evidence-first. Interfaces without production callers = **unwired**.

---

## What is now production-wired

| Capability | Evidence |
|---|---|
| Single composition root | `buildProductionRuntime` → binds via `runtime-binding.ts` |
| Browser workflows | `startBrowserUI` → ExecutionEngine |
| Chat shares runtime binding | `bindProductionRuntime`; Agent tool path uses `invokeUnderRuntime` |
| Broker on network tools | `web_search` / `scrape_url` / `deep_research` / `find_all` / `entity_search` |
| Air-gap below prompts | fetch guard + tool removal + broker deny |
| CapabilityRegistry consulted | model-client + seeded from profiles |
| Parallel webhook | `POST /api/webhooks/parallel` HMAC + DurableIdempotencyLedger |
| Office edit read-back | `edit()` → `validate()`; fail closed on validation error |
| ResearchStateStore harvest | brokered research observations record claims |
| Honest no-ops | approve / exclude / rerun no longer fake `{ok:true}` |
| Runtime status API | `GET /api/runtime/status` |
| Docs | README, providers.md, daemon.ts, SPEC §4 OpenRouter + browser UI |

Tests: `35-production-runtime` (25), `36-finish-line-wiring` (13), Office read-back checks.

---

## Verification receipts (this push)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | must be 0 |
| `npm test` | must be 0 (459 spec + harness incl. 35+36) |
| `npm run test:e2e:a` | previously 24/24 |
| Live contracts | **blocked** without credentials — not claimed |

---

## Remaining — external or consciously deferred

| Item | Class | Why not closed |
|---|---|---|
| Live OpenRouter ZDR + native MIME certs | **External** | Needs `OPENROUTER_API_KEY` + `QUIVER_LIVE_*`; profiles stay `not-run` / fail-closed until certified |
| Live Parallel search/monitor | **External** | Needs `PARALLEL_API_KEY` (+ webhook secret for live webhook) |
| Live Graph / Drive | **External** | Needs tokens + item ids |
| OfficeCLI binary checksum pins | **External / licensing** | Pins empty by design until licensed binary + digest available; empty pin = explicit "dev mode" unavailable entry |
| 9 scaffold workflow packs → demo-ready Office | **Deferred** | Engine matrix (`28`) runs all 12; document demos remain 3 packs. Full Office fixture packs are engagement work |
| Chat = ExecutionEngine (not Agent) | **Deferred** | Chat now shares ProductionRuntime binding/broker/policy; full GoalContract chat turns are a follow-on |
| Visual browser walkthrough screenshots | **Manual** | Not automated this session |
| PromptRegistry fully replacing Agent assembler | **Deferred** | Pack/PromptCompiler exist; Agent still uses assembler for chat |
| Ambient job kind handlers | **Deferred** | Scheduler injected; unknown kinds fail into DLQ honestly |

---

## Final completion questions (updated)

| Question | Answer |
|---|---|
| Default browser workflow uses real engine? | **Yes** |
| Browser, CLI, daemon share one runtime? | **Yes for production binding** — chat Agent uses same bound runtime/broker; not a second composition root |
| Mock-free workflow → real model? | **Yes when configured; else honest error** |
| OpenRouter ZDR per request? | **Yes on harness client** |
| PDF parser fallback unnoticed? | **No — refused; certs empty → fail closed** |
| Native MIME certified separately? | **Registry yes; live certs not run** |
| High-sensitivity / air-gap network tool? | **Blocked** (guard + removal + broker) |
| Air-gapped below prompts? | **Yes** |
| Parallel Monitor GA? | **Yes + webhook route with HMAC/dedupe** |
| Crashed scheduled job recovery? | **Library yes; product handlers deferred** |
| Duplicate events idempotent? | **Yes on webhook path** |
| As-of without future leakage? | **Yes (store + tests)** |
| Alert full evidence chain? | **Partial — deferred product alerts** |
| API + MCP centrally governed? | **Broker on network tools; MCP via broker registration path** |
| Office read-back verified? | **Yes on harness OfficeCliEngine.edit** |
| Customer prompts without orchestration edits? | **Packs yes; Agent assembler still mixed for chat** |
| All 12 through same harness? | **Engine matrix yes; 9 packs still scaffold for Office demos** |
| Live integrations tested? | **Blocked — credentials** |
| Differentiated capability disappeared? | **No** |
| README/SPEC truthful? | **Yes for OpenRouter + browser UI (§4 updated)** |

---

## What the next advanced coder should do first

1. Run live contract suite with real keys; record per-MIME CapabilityRegistry passes.
2. Promote scaffold packs to demo-ready one at a time (start with transcript-review).
3. Optional: replace Agent chat loop with GoalContract turns if product wants one loop.
4. Visual QA walkthrough with screenshots.
5. Fill OfficeCLI pins when licensing permits.
