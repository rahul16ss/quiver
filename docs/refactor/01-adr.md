# Architecture Decision Records (ADR) — Quiver harness refactor

ADR format: context → decision → consequences. Decisions are binding for the
refactor and referenced by phase work.

---

## ADR-001 — OpenRouter is the sole cloud model gateway

**Context.** The baseline ships a generic `OpenAICompatibleProvider` that
points at any OpenAI-compatible endpoint, plus a separate Vertex BYOK path and
Ollama-Cloud web routes. The mission requires a single, auditable cloud egress
with mandatory Zero-Data-Retention (ZDR), data-collection denial, explicit
approved provider/model routes, no automatic router, and no unapproved fallback.

**Decision.** Adopt the official TypeScript LangChain integration
`@langchain/openrouter` (`ChatOpenRouter`) as the *only* cloud model adapter,
pinned to audited exact versions of `@langchain/core`, `@langchain/openrouter`
and `@langchain/langgraph`. Wrap it in a `QuiverOpenRouterClient` that enforces
Quiver policy on every eligible cloud request:
`provider.zdr=true`, `provider.data_collection="deny"`,
`provider.require_parameters=true`, an explicit approved provider/model route,
no unapproved fallback, no automatic model router, request cancellation/timeout/
retry budgets, and usage+provider metadata capture without prompt-content
logging. If the installed `ChatOpenRouter` cannot express a mandatory OpenRouter
field or a native file content part, add the smallest possible OpenRouter-specific
passthrough inside the adapter — no second cloud stack, no LangChain fork.

Local/private models remain through a separate `LocalModelClient`.
High-sensitivity policy fails closed if no approved local/private route is
configured; it never falls back to OpenRouter.

**Consequences.** Removes the generic "any endpoint" cloud posture and the Ollama
cloud route. Capability is certified via versioned `ModelProfile` records and
opt-in live contract tests, not inferred from branding. PDFs are sent as native
file content parts with OpenRouter's `native` PDF engine on a proven route; OCR/
text-extraction/rasterization are never silently substituted. Office files are
passed natively only when the exact model/provider profile passed a contract test
for that MIME type; otherwise an OfficeCLI structural view is an explicit,
user-selected mode, never disguised as native reading.

---

## ADR-002 — LangGraph.js as a limited execution substrate

**Context.** The baseline agent loop is a hand-rolled loop in `src/agent.ts`
with its own checkpointing. The mission wants durable state, checkpointing,
resumability, timeouts and human interrupts without adopting the full
LangChain agent/tool ecosystem, and without rewriting every tool.

**Decision.** Adopt `@langchain/langgraph` for the control plane: durable state,
SQLite-backed local checkpoints (replaceable backend), timeouts and human
interrupts. Preserve Quiver's tool registry, policy checks, evidence layer,
approvals and maker/checker logic by wrapping them as graph nodes — not rewriting
every tool. Implement a typed `GoalContract` and a goal-seeking loop with an
explicit gap ledger and honest blocked/partial results.

**Consequences.** A failed tool call, unsupported event, stale source, missing
entitlement or invalid Office file can never be reported as successful
completion. The full LangChain agent/tool ecosystem is not adopted.

---

## ADR-003 — Parallel as the sole public-web research gateway

**Context.** The baseline `web_search`/`scrape_url` tools support Parallel,
Ollama-Cloud web, and a regex `direct` HTML-scraping fallback. The mission
requires Parallel (`parallel-web`) as the sole default public-web/deep-research
gateway, removal of regex HTML scraping, and removal of OpenRouter's web plugin
as the research layer (ZDR does not cover plugins).

**Decision.** Implement `ResearchGateway` with typed operations `search`,
`extract`, `research` (Task, only for broad synthesis), `monitor`, `findEntities`.
Normal research follows Search → select sources → Extract, consuming the
documented `excerpts` and `full_content` fields. Remove the `result.content`
assumption and all regex HTML stripping. Browser control is retained only for
authenticated/interactive sources and never becomes a hidden scraper fallback.
Three data-handling profiles (Public / Confidential-internal / Restricted-MNPI)
gate Parallel and cloud inference.

**Consequences.** Parallel is open-web research, never a silent substitute for
consensus, estimates, market prices, holdings, risk data or licensed research.

---

## ADR-004 — Modular PromptCompiler and customer packs

**Context.** System prompts are scattered across the assembler, security module
and skills, and are customer-insensitive.

**Decision.** Replace them with a versioned `PromptCompiler` compiling from
explicit layers: runtime invariants/safety → capital-markets domain policy →
customer pack → workflow spec → role prompt (planner/maker/checker/reviewer) →
current goal + approved context → gap ledger + run state. A `CustomerPack` is
data/configuration (not a code fork), versioned, diffable, exportable,
importable, rollbackable, and never contains secrets. Prompts speak to an
analyst/associate/PM/adviser/reviewer, require separation of fact/derived value/
assumption/interpretation/recommendation, and forbid autonomous portfolio
decisions or representing drafts as investment advice.

**Consequences.** Scattered large system prompts are consolidated; customer
specificity is data, not a fork.

---

## ADR-005 — Storage and artifact lifecycle separation

**Context.** The baseline can mutate source files directly during generation.

**Decision.** Separate `StorageProvider` (checkout/metadata/list/version/commit/
conflict/permissions/polling) from `ArtifactRepository` (immutable source
snapshot → hash/version → isolated working copy → candidate output →
semantic/visual diff → evidence companion → approval state → committed
identity). All Office work follows: resolve stable source identity → checkout
into staging → hash+snapshot → edit working copy → validate → render/inspect →
checker → show change set → approve → commit as new version/file → retain
provenance+rollback. Never edit the original directly during generation.

**Consequences.** Local storage is restricted to configured roots with lock/change
detection, atomic writes and recoverable backups. Microsoft 365 uses Graph with
Entra OAuth, OS-credential-store refresh tokens, preserved IDs/ETags/versions,
upload sessions, fail-on-conflict (no `conflictBehavior:"replace"`), and delta
queries. Google Drive uses OAuth + stable file IDs, shared drives, revision
metadata, distinguishes Office from Google-native docs, never silently converts,
and re-fetches metadata before commit when conditional-overwrite safety cannot
be guaranteed. Synced folders are labelled reduced-guarantee local mode.

---

## ADR-006 — OfficeCLI as the primary OfficeEngine, pinned and bundled

**Context.** OfficeCLI is already the document engine, but the mission requires
a pinned, bundled, checksum-verified binary with no floating self-update.

**Decision.** Bundle a specific audited OfficeCLI binary per platform, verify it
with a pinned checksum, include license notices, disable background self-updates.
OfficeCLI handles structured read/edit, templates/deterministic merge, atomic
batch changes, comments/review metadata, validation, render–look–fix, and
semantic/visual comparison. A conformance corpus tests preservation of formulas,
named ranges, hidden/protected sheets, charts/pivots/conditional formatting,
external links, comments/tracked changes, fonts/themes/layouts, embedded
objects, signs/units/currencies, repair warnings, and Word/PowerPoint round
trips. Macro-enabled/encrypted/IRM/sensitivity-labelled files are high-risk,
read-only/copy-on-write by default; macros are never executed. An optional final
native-Office review/recalculation gate is documented for high-stakes Excel.
No Graph Excel APIs, Office Scripts, VBA/COM, or Office Add-in as the primary
engine. No Office Add-in is built in this refactor; the daemon API stays suitable
for a later thin Office.js task pane that never contains the runtime.

**Consequences.** OfficeCLI is not Microsoft Office; the remaining fidelity
boundary is documented.

---

## ADR-007 — Capital-markets domain hardening

**Context.** The baseline has evidence/lineage and connector provenance but no
explicit source-category model or domain-normalization types.

**Decision.** Represent source categories explicitly (market data & estimates,
filings & IR, transcripts & events, portfolio models & trackers, internal
research & notes, public web research). Every workflow resolves required
categories to concrete approved connectors; no substitution without explicit
warning + approval. Add domain-normalization types/checks for issuer/security
identity, fiscal calendars/periods, actual vs estimate vs guidance, reported vs
adjusted, currency/units/scale/sign, point-in-time/as-of, corporate actions/
restatements, source precedence/contradictions, entitlements/redistribution/
cache expiry. Every material claim/figure carries value, unit/currency, as-of
date/fiscal period, source identity/locator, source category, retrieved-at,
transformation, status (sourced/derived/assumed/unresolved/conflicting), and
reviewer+decision. The review UI accepts/rejects individual changes/claims/cells/
paragraphs/slides, not only whole-run approval.

**Consequences.** Point-in-time financial semantics and source precedence are
first-class; category substitution is visible.

---

## ADR-008 — Integrations, code execution, memory, ambient operation

**Context.** These differentiators already exist; the mission tightens their
contracts.

**Decision.** `IntegrationBroker` retains direct APIs and MCPs; each integration
declares capabilities, auth/scopes, data classification, read/write side
effects, required approvals, licensed-data restrictions, rate limits/costs,
health/freshness. MCP output and tool descriptions are untrusted input with
preserved provenance. Deterministic code execution enforces isolated cwd, CPU/
memory/time limits, network policy, dependency allowlist, no ambient credential
access, path controls, output hashes, and explicit approval for external/
destructive effects. Memory harvesting produces only proposals, scoped by
customer/team/user/project/workflow with source/sensitivity/expiry/supersession
metadata; never auto-promoted without review. The daemon and ambient triggers
gain deduplication, materiality thresholds, quiet hours, market/earnings
calendars and alert routing; an ambient event may prepare a draft + evidence but
must never silently overwrite a live model, memo or client deliverable.

**Consequences.** Existing differentiators are preserved and tightened, not
rewritten for cleanliness.

---

## ADR-009 — Browser UI replaces Electron; minimal launcher/CLI

**Context.** The baseline ships an Electron app and an interactive TUI.

**Decision.** Replace Electron with a responsive browser application served
locally by the daemon. The daemon binds to loopback only with a per-install
secret, strict origin validation, CSRF protection, secure headers and explicit
local-file root grants; not LAN-exposed by default. A small launcher/CLI handles
start/stop/status, opening the browser, workspace selection, "open with Quiver",
diagnostics/connector tests, and service/autostart management. Electron and TUI
code are removed only after the replacement passes equivalence.

**Consequences.** The normal user journey (select → approve context → confirm
goal → follow progress → inspect change set → accept/reject → commit → optional
monitoring/memory review) is the experience plane. Partial completion and
limitations are shown honestly; "complete" is never shown when mandatory
evidence/validation/save-back failed.

---

## ADR-010 — Observability, evaluation, security

**Context.** LangGraph supports LangSmith; the mission forbids leaking prompts/
documents/excerpts/tool results to a SaaS by default.

**Decision.** A `TraceSink` abstraction with local/customer-controlled
OpenTelemetry as the default. LangSmith is an explicit, redacted customer
option only. Capture metadata to diagnose graph/node transitions, model/
provider used, tool calls/outcomes, latency/retries/cost, source coverage/
freshness, document validation, approvals/conflicts, stop reason. Add threat
tests for prompt injection (documents/web/MCP), SSRF, malicious Office packages,
zip bombs, DDE/external links, macros, path traversal, browser downloads,
credential leakage. CI uses mocks + deterministic fixtures; opt-in live contract
tests exercise OpenRouter, native file ingestion, Parallel, SharePoint/OneDrive,
Google Drive, OfficeCLI.

**Consequences.** No confidential content leaves the configured boundary through
observability.

---

## ADR-011 — Additive, reversible migration; no premature removal

**Context.** The mission: "Do not remove the existing implementation until its
replacement passes equivalence tests."

**Decision.** New `src/harness/` modules implement the ten narrow interfaces
and four planes additively, with their own tests wired into `npm test`. Legacy
modules stay in place and green until a phase explicitly migrates callers and
removes the old path. Each phase runs the relevant tests and preserves current
guarantees before proceeding.

**Consequences.** The 447-check baseline and 34 e2e checks remain green
throughout; removals happen late and only after equivalence.