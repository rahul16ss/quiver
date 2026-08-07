# Quiver Harness Architecture (refactor)

> **Historical snapshot.** This document records the production-refactor
> baseline and phased plan as of the audit/migration period. Current engineering
> status is **`NOTES/FINISH_LINE.md`** (HEAD `cbb0b67`, 2026-08-07): Electron /
> `ui/` / `npm run gui` / interactive `tui.ts` are removed; the buyer surface is
> the loopback browser UI (`src/harness/ui/`); OpenRouter is the sole shared cloud
> gateway; Parallel is the sole public-web research gateway; production callers
> share `buildProductionRuntime()`. Treat claims below as historical unless
> independently confirmed against current source.


> This document describes the **target** harness architecture being introduced
> by the production refactor. It is additive over the legacy architecture in
> [architecture.md](architecture.md); legacy modules remain in place and green
> until each phase migrates callers and removes the old path. For the phase
> plan, ADRs and migration map see [../refactor/](../refactor/).

## What Quiver is becoming

Quiver is a thin, dependable, customer-configurable capital-markets workflow
harness for Conviction Studio’s services business — not a generic chatbot and
not a collection of hard-coded finance applications. It is an open foundation
configured around a client’s existing process, templates, data entitlements,
storage and review rules.

The target flow:

```
approved context and sources
  → explicit goal and acceptance criteria
  → resumable research and tool execution
  → native Office working copy
  → deterministic verification and independent critique
  → inspectable change set and evidence
  → human approval
  → version-aware commit to client-owned storage
  → optional monitored updates and reviewed memory proposals
```

## Four planes

| Plane | Responsibility | Harness modules |
| :--- | :--- | :--- |
| **Control** | LangGraph state, checkpoints, goals, budgets, policies, approvals, resumability | `ExecutionEngine`, `PolicyEngine`, `GoalContract`/`GapLedger` (`goal-contract.ts`) |
| **Knowledge** | Local/internal storage, public research, licensed data APIs, MCP servers | `ResearchGateway`, `IntegrationBroker`, `ModelClient` (inference egress), `StorageProvider` (read side) |
| **Work-product** | Immutable source snapshots, staged working copies, OfficeCLI, evidence, diffs, commits | `ArtifactRepository`, `OfficeEngine`, `StorageProvider` (commit side) |
| **Experience** | Local browser UI, minimal launcher/CLI, future Office Add-in boundary | (Phase 8) + `TraceSink` spans all planes |

## Ten narrow interfaces

Implemented as TypeScript interfaces with explicit constructors and small
registries — no DI framework. Defined in [`src/harness/interfaces.ts`](../../src/harness/interfaces.ts):

`ModelClient`, `ExecutionEngine`, `ResearchGateway`, `StorageProvider`,
`ArtifactRepository`, `OfficeEngine`, `IntegrationBroker`, `PromptCompiler`,
`PolicyEngine`, `TraceSink`.

## Shipped so far (this refactor)

| Module | Status | Notes |
| :--- | :--- | :--- |
| `interfaces.ts` | shipped | ten interfaces + shared domain enums |
| `customer-pack.ts` | shipped | versioned, secret-free, fail-closed; registry w/ load/export/rollback/diff |
| `policy-engine.ts` | shipped | sensitivity classification, fail-closed decisions, source-category resolution |
| `artifact-repository.ts` | shipped | snapshot → working copy → candidate → evidence → diff → approval → commit → rollback |
| `trace-sink.ts` | shipped | content-redacting local sink (no SaaS by default) |
| `prompt-compiler.ts` | shipped | 7-layer compiler (safety → domain → pack → workflow → role → goal → gap ledger) |
| `model-profile.ts` | shipped | certified capability records; `not-run` until contract tests pass |
| `model-client.ts` | shipped | `QuiverOpenRouterClient` (sole cloud gateway) + `LocalModelClient`; policy-enforcing |
| `research-gateway.ts` | shipped | `ParallelResearchGateway` (sole public-web gateway); no regex scraping |
| `goal-contract.ts` | shipped | `GoalContract` + `GapLedger` + honest completion evaluation |

## OpenRouter — the only cloud model gateway

`QuiverOpenRouterClient` wraps `ChatOpenRouter` (`@langchain/openrouter@0.4.5`)
and enforces on every eligible cloud request:

- `provider.zdr = true`
- `provider.data_collection = "deny"`
- `provider.require_parameters = true`
- an explicit approved provider/model route (from a certified `ModelProfile`)
- `allow_fallbacks = false` (no unapproved fallback endpoints)
- no `models` list / no `route: "fallback"` (no automatic model router)
- request cancellation, timeout and retry budgets (no retry on 4xx auth/policy)
- usage + provider metadata capture **without prompt-content logging**

The installed `ChatOpenRouter` natively expresses `provider.zdr`,
`data_collection`, `require_parameters`, `allow_fallbacks`, `order`, and the
`file-parser` plugin with `pdf.engine: "native"`. For native file content parts,
the transport builds the OpenRouter-specific `file` content part — the smallest
possible passthrough; no second cloud stack, no LangChain fork.

**Native document requirement.** PDFs are sent as a `file` content part with
the `file-parser` PDF engine forced to `native` on a route proven (by contract
test) to accept native PDFs. OCR, text extraction, page rasterization and image
splitting are never silently substituted; the client fails closed when a
profile is not certified for a MIME type. DOCX/XLSX/PPTX are passed natively
only when the exact model/provider profile passed a contract test for that MIME.
OfficeCLI may always inspect/manipulate Office files deterministically; an
OfficeCLI-derived structural view is offered only as an explicit, user-selected
mode, never disguised as native reading.

**Local/private escape hatch.** `LocalModelClient` serves private models.
High-sensitivity (restricted-MNPI) policy fails closed if no approved
local/private route is configured; it never falls back to OpenRouter.

## Parallel — the only public-web research gateway

`ParallelResearchGateway` wraps `parallel-web@1.1.0` behind `ResearchGateway`
with typed operations `search`, `extract`, `research` (Task, only for broad
synthesis), `monitor`, `findEntities`. Normal research follows
Search → select sources → Extract, consuming the documented `excerpts` and
`full_content` fields. There is no `result.content` assumption and no regex
HTML stripping. Browser control is retained separately for
authenticated/interactive sources only and is never a hidden fallback.

Three data-handling profiles gate Parallel:

| Profile | OpenRouter (ZDR) | Parallel |
| :--- | :--- | :--- |
| Public | permitted | permitted |
| Confidential-internal | permitted | sanitized public queries only (no internal thesis/client context) |
| Restricted/MNPI | only via approved local/private route | forbidden |

ZDR and SOC 2 are necessary controls, not automatic permission to transmit MNPI.

## What is preserved (differentiators)

The refactor preserves — and does not rewrite for cleanliness — the local
daemon and ambient/event operation, browser control, direct API + MCP
integrations, licensed data-vendor connectors, deterministic code generation +
sandbox, automatic post-run memory harvesting into a review queue, evidence and
lineage, maker/checker separation, native Office generation, render–look–fix,
the local/private-model escape hatch, and the minimal CLI.

## What is removed or replaced (gated on equivalence)

Electron, the interactive TUI, the generic “any OpenAI-compatible endpoint”
cloud posture, Ollama Cloud as a separate route, regex-based HTML scraping,
silent fallbacks, direct source mutation, and scattered customer-insensitive
prompts. Each removal happens only in its phase, after the replacement passes
equivalence tests (see [../refactor/02-migration-map.md](../refactor/02-migration-map.md)).