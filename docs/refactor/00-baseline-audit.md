# Quiver Refactor — Phase 0: Baseline Audit

> Source of truth: repository, tests and documentation at the audited commit.
> This record is the agreed starting point for the production refactor. It is
> written *before* any production code is changed so every later phase can be
> measured against it.

## 1. Baseline commit

- **Known audit baseline:** `061d56e7510bd6aa074802cb83a2ee629f59099d`
- **Verified current HEAD:** `061d56e7510bd6aa074802cb83a2ee629f59099d` ✅ (matches)
- **Working tree:** clean (no uncommitted changes at audit time)

## 2. Test baseline (recorded before any change)

| Gate | Command | Result |
| :--- | :--- | :--- |
| Spec acceptance (checker-owned) | `npm test` | **447 / 447 checks pass** |
| Offline + OfficeCLI e2e | `npm run test:e2e -- --tier=a,b` | **34 / 34 pass** |
| Live contract (tier c/d) | `npm run test:e2e:live` | opt-in, not run in CI |

These are the guarantees every phase must preserve. Per the mission, no existing
implementation is removed until its replacement passes equivalence tests, so the
refactor proceeds additively: new `src/harness/` modules are introduced with
their own tests, and legacy modules remain in place (and green) until a phase
explicitly migrates callers and removes the old path.

## 3. Repository shape at baseline

Top-level: `src/` (runtime), `ui/` (Electron app), `tests/`, `docs/`,
`examples/`, `workflow-packs/`, `skills/`, `bin/`, `scripts/`, `Formula/`,
`templates/`, `profiles/`, `branding/`.

Key runtime subsystems already present (these are differentiators to *preserve*):

- `src/agent.ts` (3.6k lines) — core agent loop, approval gates, tool execution.
- `src/providers/` — `OpenAICompatibleProvider` (generic OpenAI-compat transport),
  `vertex_auth.ts` (customer GCP BYOK), `tool_call_passthrough.ts`.
- `src/adapters/` — per-model prompting/tool-format adapters (`DefaultAdapter`).
- `src/tools/` — 31 static tools incl. `office_doc`, `evidence`, `data_query`,
  `web_search`, `scrape_url`, `deep_research`, `entity_search`, `browser_control`,
  `sandbox`, `run_command`, memory tools.
- `src/workflow/` — ambient workflow engine: `orchestrator`, `loader`, `scheduler`,
  `watcher`, `review`, `handover`, `drift`, `types`.
- `src/connectors/framework.ts` — data-vendor `DataConnector` plugin registry with
  provenance + local cache + TTL.
- `src/evidence/` — `EvidenceTracker`, `model.ts`, `validator.ts` (live lineage).
- `src/document/` — Render→Look→Fix (`rlf_orchestrator`), `bar_critic`, `word_lineage`.
- `src/memory/` — schema, review queue, privacy filter, citations, decay, versioned.
- `src/security/` — path policy, command policy, seatbelt, scratch area, sensitivity,
  consent gate, private-URL/SSRF guard, secrets redaction.
- `src/session/` — checkpoints, file access, schema.
- `src/subagents/` — maker/checker (`checker.ts`, `checker_filter`, `checker_vision`).
- `src/daemon/` — daemon + client (local API surface).
- `src/fs/atomic_write.ts` — atomic writes with rollback.
- `src/prompt/assembler.ts` — deterministic 9-section prompt assembly.
- `src/prompts/security.ts` — security preamble + untrusted-content wrapping.

## 4. Differentiators present at baseline (must be preserved, not rewritten)

| Differentiator | Baseline location | Status |
| :--- | :--- | :--- |
| Local daemon + ambient/event triggers | `src/daemon/`, `src/ambient.ts`, `src/workflow/{scheduler,watcher}.ts` | present |
| Browser control for authenticated/interactive sites | `src/tools/browser_control.ts` | present |
| Direct API + MCP integrations | `src/connectors/`, `src/mcp/` | present |
| Licensed data-vendor integrations | `src/connectors/framework.ts` | present (framework; connectors per-engagement) |
| Deterministic code generation + sandboxed execution | `src/tools/sandbox.ts`, `run_command`, `run_tests` | present |
| Automatic post-run memory harvesting → review queue | `src/memory/{episodic_harvester,review_queue}.ts` | present |
| Evidence, lineage, run records, source-backed claims | `src/evidence/`, `src/document/word_lineage.ts` | present |
| Maker/checker separation, approval gates, rollback | `src/subagents/checker.ts`, `src/security/{consent_gate,approval_cache}.ts`, `src/fs/atomic_write.ts` | present |
| Native Word/Excel/PowerPoint generation + editing | `src/tools/office_doc.ts` (OfficeCLI) | present |
| Render–Look–Fix document QC | `src/document/rlf_orchestrator.ts` | present |
| Local/private-model escape hatch | `src/providers/types.ts` `getLocalProvider()`, `config.localLlm*` | present |
| Minimal CLI for install/diagnostics/automation | `src/cli.ts`, `bin/quiver.js` | present |

## 5. Things the mission says to remove or replace

| To remove/replace | Baseline location | Refactor target |
| :--- | :--- | :--- |
| Electron application | `ui/` (main/preload/renderer), `package.json` build config | Phase 8: browser UI served by daemon; remove Electron only after replacement passes |
| Interactive TUI | `src/tui.ts`, `src/multiline.ts`, `src/cli_ui.ts` | Phase 8: minimal launcher/CLI |
| Generic "any OpenAI-compatible endpoint" cloud posture | `src/providers/types.ts` `OpenAICompatibleProvider` | Phase 2: OpenRouter as sole cloud gateway via `@langchain/openrouter` |
| Ollama Cloud as a separate cloud route | `src/providers/vertex_auth.ts` `isOllamaHost`, `web_search`/`scrape_url` Ollama paths | Phase 2/3: local Ollama only as `LocalModelClient`; no Ollama cloud route |
| Regex-based HTML scraping | `src/tools/scrape_url.ts` `htmlToText()` + `direct` fallback | Phase 3: Parallel Extract only; remove regex `direct` fallback |
| Silent provider/parser/research/storage fallbacks | `scrape_url` fall-throughs, provider defaults | Phases 2/3: fail closed, no silent fallback |
| Direct mutation of source files in synced folders | `src/tools/office_doc.ts` write paths | Phase 6: staged working copies via `ArtifactRepository` |
| Scattered, duplicated, customer-insensitive system prompts | `src/prompt/assembler.ts`, `src/prompts/security.ts`, skills | Phase 5: versioned `PromptCompiler` + `CustomerPack` |

## 6. Twelve reference workflow scenarios (acceptance boundary)

The repository already declares 13 workflow packs across 3 families
(`workflow-packs/{dealmaking,research,wealth}/`). Three are runnable
credential-free demos; the rest are scaffolds. The mission's twelve scenarios
map to existing packs (risk-exposure-summary is the 13th and is a scaffold that
names `.pdf`, which `office_doc` does not yet emit — it is treated as a template).

| # | Scenario | Baseline pack | Family |
| :--- | :--- | :--- | :--- |
| 1 | Earnings update | `research/post-earnings-evidence-pack` | research |
| 2 | Transcript review | `research/transcript-review` | research |
| 3 | Company/sector primer | `research/company-primer` | research |
| 4 | Thesis tracking | `research/thesis-tracker` | research |
| 5 | Investment committee memo | `dealmaking/investment-committee-memo` | dealmaking |
| 6 | Diligence tracker | `dealmaking/diligence-tracker` | dealmaking |
| 7 | Market map | `dealmaking/market-map` | dealmaking |
| 8 | Pitchbook/transaction materials | `dealmaking/pitchbook-materials` | dealmaking |
| 9 | Portfolio review pack | `wealth/portfolio-review-pack` | wealth |
| 10 | Investment proposal | `wealth/investment-proposal` | wealth |
| 11 | Manager research note | `wealth/manager-research-note` | wealth |
| 12 | Client commentary | `wealth/client-commentary` | wealth |

Phase 9 expresses each as a declarative `WorkflowSpec` with synthetic/public
inputs, required source categories, deliverable type, acceptance checks and
reviewer gates — as harness tests, not twelve special-purpose production agents.

## 7. Architectural planes (target)

1. **Control plane** — LangGraph state, checkpoints, goals, budgets, policies,
   approvals, resumability.
2. **Knowledge plane** — local/internal storage, public research (Parallel),
   licensed data APIs, MCP servers.
3. **Work-product plane** — immutable source snapshots, staged working copies,
   OfficeCLI, evidence, diffs, commits.
4. **Experience plane** — local browser UI, minimal launcher/CLI, future Office
   Add-in boundary.

## 8. Ten narrow interfaces (target, Phase 1)

`ModelClient`, `ExecutionEngine`, `ResearchGateway`, `StorageProvider`,
`ArtifactRepository`, `OfficeEngine`, `IntegrationBroker`, `PromptCompiler`,
`PolicyEngine`, `TraceSink`. Implemented as TypeScript interfaces with explicit
constructors and small registries — no DI framework.