<p align="center">
  <img src="branding/logo.png" alt="Quiver" width="128">
</p>

<h1 align="center">Quiver</h1>

<p align="center"><strong>An open foundation for controlled, source-backed document workflows in finance.</strong></p>

---

## What Quiver is

Quiver helps turn approved files, public research, workflow instructions, and review
rules into native Office deliverables with inspectable evidence. [Conviction
Studio](https://convictionstudio.com) uses it as one foundation for bespoke client
workflow engagements.

A Quiver workflow starts from material an investment team already has — a memo
template, an Excel model, filings, transcripts, notes — and produces a Word, Excel,
or PowerPoint draft in which important figures and claims are connected to sources
the reviewer can inspect, or explicitly flagged for review.

**Quiver is infrastructure, not investment advice and not a turnkey replacement for
professional judgment.** Generated work remains a draft until a professional reviews it.

## Flagship example

The repository ships one end-to-end example: an **investment committee memo** for a
synthetic company ("Project Alder").

```bash
npm run demo:ic-memo
```

From a memo template, an Excel model, a filing excerpt, a transcript excerpt, an
internal note, and a vendor-style CSV export (all synthetic, no credentials or
network needed), it generates:

- `Project_Alder_IC_Memo.docx` — a native Word memo in the firm template
- `Project_Alder_Evidence.json` / `.html` — an evidence map connecting each key
  figure and claim to its source (for Excel-sourced figures, down to the sheet and
  cell — verified by reading the workbook back)
- `Project_Alder_Review_Checklist.md` — unresolved and flagged items for the reviewer
- `Project_Alder_Run_Record.json` — inputs used, sources excluded, workflow version,
  review status

Acceptance checks then verify the output before it is reported as done: required
sections exist, the document validates, every quantitative claim has a source or a
flag, Excel-sourced figures match the actual model cells, and unresolved items
appear in the review checklist.

See [`examples/investment-committee-memo/`](examples/investment-committee-memo/)
for the workflow definition (`workflow.yaml`), the acceptance checklist, and how the
same pattern is configured for real engagements.

## Core principles

1. **Controlled context** — The user can understand and control the files,
   instructions, sources, and memory used for a workflow.
2. **Inspectable evidence** — Important figures and claims can be connected to
   sources or explicitly flagged for review.
3. **Native deliverables** — Workflows produce Word, Excel, and PowerPoint files
   rather than only chat or Markdown.
4. **Human responsibility** — Generated work remains a draft until a professional
   reviews it.
5. **Data boundaries** — Model use, local processing, remote calls, redaction, and
   approved sources are configured around the workflow.
6. **Model independence** — Workflow context and process should not disappear when
   the model provider changes.

## Current capability status

Honest status as of this release. Do not infer more from the docs than this table states.

| Area | Status |
|------|--------|
| Native Word / Excel / PowerPoint output (via [OfficeCLI](https://officecli.ai)) | Working — files validate and open natively |
| Evidence model (source registry, claim records, evidence report) | Working in the flagship example |
| Excel figure verification (claimed value vs actual cell) | Working in the flagship example, for Excel-sourced figures |
| Cell-level lineage for non-Excel sources | Not implemented — evidence is file / sheet / section / page / URL level |
| Web research (search, scrape, deep research) | Working — requires a Parallel API key; sources pass through for review |
| Verification gate (isolated checker reviews high-risk changes before commit) | Working, always on |
| Tamper-evident audit log (hash-chained, provenance-covered) | Working — provenance fields are cached from the hash-covered payload; `verifyChain` detects post-hoc edits |
| Secrets in OS keychain, secret redaction in logs | Working |
| Trust tiers and approval gates (per-project, persisted) | Working |
| Model adapters (GLM, Claude) over an OpenAI-compatible interface | Working |
| Local-only model execution | Configurable (local endpoints supported); **the default model endpoint is a cloud service** — see Data handling below |
| Redaction rules, sensitivity-based routing | Framework shipped — sensitivity classification, MNPI redaction, per-tier model routing (low→cloud, mid→cloud-redacted, high→local); wired into agent loop |
| Evidence tracking (live lineage during agent drafting) | Shipped — source registry, claim records, validation, Evidence.json output; lineage chips render in the desktop GUI and the §8.3 verification rail shows the source (Excel cell, filing excerpt, or web page) |
| Reviewer sign-off flow (verify / flag / needs-analyst) | Shipped in the desktop app — mark-final is blocked while a document has open flags; override is logged to a per-document tamper-evident audit chain + review record |
| Checker rejects unsourced quantitative figures | Working — the isolated checker validates the evidence file for Office documents and returns "revise" on unsourced quantitative claims |
| Scratch-area semantics (draft writes redirect to scratch, human promotes) | Shipped — `/promote` command |
| Consent gate (pre-action summary that blocks until approved) | Shipped — `/consent` toggle; when enabled, the agent waits for approve / decline / exclude before each model call |
| Versioned memory (snapshots, diff, rollback) | Shipped — `/memory-history`, `/memory-rollback`, `/memory-diff` |
| Data connectors (plugin framework for external data sources) | Framework shipped — sample EDGAR connector included |
| Render→look→fix orchestration for Office documents | Shipped — `src/document/rlf_orchestrator.ts` |
| Live-draft demo (real tool run, not replayed fixtures) | Shipped — `npm run demo:ic-memo:live` drives the real evidence tracker + audit chain + OfficeCLI end-to-end (8/8) |
| Desktop app (Electron: chat, context panel, document preview, approvals) | Working, unsigned build |

## Data handling

Be precise: by default the primary model is served from a cloud endpoint
(`https://ollama.com/v1`), so prompt content — including file content the workflow
reads — is sent to that provider. Memory, sessions, documents, and the audit log
live in files on your machine. Local model endpoints are supported and can be
configured where an engagement requires it. Web research tools call external
services only when used. There is no telemetry.

**Data handling and model use are configured around the workflow's sensitivity.**
Do not treat the defaults as a confidentiality guarantee.

## Architecture overview

```
~/.quiver/                          # Global (shared across projects)
├── core.json                        # Identity + user context
├── skills/                          # Skills (reusable procedures)
└── projects/{name}/
    ├── memory/                      # Per-project memory (persona, facts, preferences)
    └── .sessions/                   # Session logs + state
```

Key modules: agent loop with approval gates (`src/agent.ts`), context assembly and
token budgeting, harness adapters per model family, security layer (command
classifier, path sandbox, macOS seatbelt, permissions store), isolated checker for
verification, hash-chained audit log, Office document tool (OfficeCLI), web research
tools, and an Electron desktop app sharing the same memory and sessions as the CLI.

See [`docs/architecture.md`](docs/architecture.md) for detail and
[`docs/advanced.md`](docs/advanced.md) for developer-oriented capabilities
(MCP servers, GitHub tooling, runtime tool creation, subagents, cloud folder sync)
that are intentionally not part of the finance-workflow surface.

## Quick start

Prerequisites: Node 20+, [OfficeCLI](https://officecli.ai) for Office output.

```bash
# Flagship demo — no API keys or network needed
npm install
npm run demo:ic-memo

# Desktop app
npm run gui

# CLI
npm install -g .
quiver init        # set up .env / keychain
quiver             # start a session
```

Configuration is a small, fixed set of environment variables (see `.env.example`).
`OLLAMA_API_KEY` powers the primary LLM and vision adapters; `PARALLEL_API_KEY`
(optional) powers web research. API keys can be stored in the OS keychain. Model
names are source-controlled in `src/config.ts`.

## Development

```bash
npm test            # Checker-owned acceptance contract — must stay green
npx tsc --noEmit    # Definition of done: clean typecheck
npm run demo:ic-memo # Flagship workflow + acceptance checks
```

The acceptance contract (`tests/spec_acceptance_tests.ts`) is a single checker-owned
file of 355 behavioral assertions. It verifies both spec compliance and that modules
are actually wired into the agent loop and tools — not just that the code exists.
`npm test` is the only live verdict — re-run it before trusting any status text.
See `tests/ACCEPTANCE_CONTRACT.md` and `docs/testing.md`.

Commercial positioning and public claims are governed by a capability truth table
maintained in the Conviction Studio engagement repository; this README's capability
status section mirrors it and must stay consistent.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md).
