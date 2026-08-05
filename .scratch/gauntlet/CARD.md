# Quiver Gauntlet Loop — Conviction Studio harness bar

Inspired by AI Loop Engineering / Gauntlet (objective · metric · boundary).

## Objective

Make Quiver a **customer-ready Associate/VP harness** for capital-markets work:

1. Users own memory (local, reviewable, provenance-bearing).
2. Users control context every turn (manifest + consent on finance profile).
3. Users can inspect work (evidence, fail-closed checker, audit).
4. Claimed capabilities are real or honestly labeled (demo-ready vs scaffold).
5. Vertex BYOK + provider-opaque tool-call passthrough work for resumed sessions.
6. Flagship workflows (IC memo, post-earnings, portfolio review) pass acceptance.
7. CLI surfaces advertised in README actually exist and fail closed on refuse.

**Out of scope this loop:** live vendor data integrations (EDGAR/Parallel deep
research spot-checks beyond existing config), Windows live installer/Task
Scheduler/Credential Manager verification.

## Metric (must all be true)

| # | Evidence |
|---|----------|
| M1 | `npx tsc --noEmit` clean |
| M2 | `npm test` — all acceptance checks green |
| M3 | `npm run demo:ic-memo`, `demo:post-earnings`, `demo:portfolio-review`, `demo:ic-memo:live` pass |
| M4 | `npx tsx scripts/stress_min_live.ts` — all pass |
| M5 | `npx tsx scripts/stress_live_workflows.ts` — all pass (incl. refuse-exit) |
| M6 | Fresh critic finds **zero P0/P1** against `docs/principles.md` |
| M7 | `quiver workflow list` works; unknown positionals exit usage; refuse exits nonzero |

## Boundary

- Do not change billing/legal/public marketing claims beyond honesty fixes.
- Do not add speculative tools or new product surface.
- Do not run Windows verification.
- Do not spend on live vendor integration tests beyond Vertex maker/checker already in use.
- Stop when M1–M7 hold for one full round with no new P0/P1, or after 5 rounds /
  diminishing returns (same finding twice with no safe fix).
- Escalate to human for secrets, code-signing, production deploy.

## Rounds log

See `gauntlet-state.json` in this folder.
