# Version Pins — Phase 2/3 prerequisite

> **Historical snapshot.** This document records the production-refactor
> baseline and phased plan as of the audit/migration period. Current engineering
> status is **`NOTES/FINISH_LINE.md`** (HEAD `cbb0b67`, 2026-08-07): Electron /
> `ui/` / `npm run gui` / interactive `tui.ts` are removed; the buyer surface is
> the loopback browser UI (`src/harness/ui/`); OpenRouter is the sole shared cloud
> gateway; Parallel is the sole public-web research gateway; production callers
> share `buildProductionRuntime()`. Treat claims below as historical unless
> independently confirmed against current source.


Audited exact versions, pinned with `--save-exact` (no `^`/`~`). These are the
only cloud/research SDKs the harness depends on beyond the existing runtime.

| Package | Pinned version | Purpose | ADR |
| :--- | :--- | :--- | :--- |
| `@langchain/core` | `1.2.4` | LangChain core (messages, tools) | ADR-001/002 |
| `@langchain/openrouter` | `0.4.5` | `ChatOpenRouter` — sole cloud model adapter | ADR-001 |
| `@langchain/langgraph` | `1.4.9` | Durable state, checkpoints, interrupts | ADR-002 |
| `parallel-web` | `1.1.0` | Sole public-web/deep-research gateway | ADR-003 |

Resolved via `npm view <pkg> version` on the audit date and installed with
`npm install --save-exact <pkg>@<version>`.

## Audit notes

- `npm audit` reports 5 vulnerabilities (4 high, 1 critical) in **transitive
  dev dependencies** of the pre-existing `electron` and `puppeteer` stacks
  (`tar`, `undici`, `js-yaml` via `node-gyp`). None originate from the four
  pinned packages above. `npm audit fix` is intentionally **not** run because it
  could alter the pinned exact versions; these are tracked for the Phase 8
  Electron removal, after which the `electron` dependency and its transitive
  tree are removed entirely.
- No `^`/`~` ranges are used for these four packages. A future bump requires a
  new audit entry here and re-running the live contract tests.

## Why exact pins

The mission requires audited exact versions so a cloud egress path is
reproducible. Floating ranges would let a transitive `@langchain/openrouter`
update change which OpenRouter provider fields are expressed — and therefore
whether `provider.zdr` / native file content parts are honored. The
`QuiverOpenRouterClient` adds the smallest possible OpenRouter-specific
passthrough when the installed `ChatOpenRouter` cannot express a mandatory
field, so a minor-version drift is detected by contract tests rather than
silently changing data-handling guarantees.