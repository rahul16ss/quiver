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

### Example workflow families

- **Investment research**
- **Dealmaking and diligence**
- **Wealth and portfolio communication**

Project Alder is the first complete reference implementation. Additional workflow packs will be shaped through customer discovery rather than built speculatively.

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

## For commercial buyers: 5-minute summary

If you are evaluating Quiver for an investment, advisory, or wealth team, here are the five core answers:

1. **Approved information sources** — Works with internal files, licensed data exports, and public filings. Data boundaries and approved sources are agreed per workflow before drafting begins.
2. **Native Office deliverables** — Drives Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) natively matching your firm's templates and styling.
3. **Inspectable figures & evidence** — Quantitative figures link directly to source cells in Excel or page excerpts in filings/transcripts for rapid verification.
4. **Human review & approval gate** — All generated output remains a draft. Senior reviewers inspect flagged items, override interpretations, and sign off before final release.
5. **Team operation & handover** — Handed over with operating runbooks, acceptance criteria, and user training so your analysts run and adapt the process autonomously.

### Hardened deployment profile: `finance-client`

For institutional clients requiring strict operational boundaries, Quiver supports a hardened `finance-client` deployment profile:
- **Enabled**: Native Office document tools, evidence map tracking, approved retrieval connectors, and human review approval gates.
- **Disabled by default**: Arbitrary shell execution, runtime tool creation, unapproved external tool servers, and background cloud sync.
- **Deployment note**: Client teams do not need to install developer dependencies during discovery; deployment and environment setup are fully scoped as part of the sprint engagement.

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
| Local-only model execution | Configurable (local endpoints supported; operator configures `LLM_API_BASE_URL`) — see Data handling below |
| Data handling configuration | Framework shipped — model use and approved sources are configured around the workflow's sensitivity (per-engagement configuration) |
| Evidence tracking (source registry, claim records, evidence report) | Working in the flagship example — sources, claims, and review status recorded in Evidence.json; lineage chips render in the desktop GUI and the verification rail shows the source (Excel cell, filing excerpt, or web page) |
| Reviewer sign-off flow (verify / flag / needs-analyst) | Shipped in the desktop app — mark-final is blocked while a document has open flags; override is logged to a per-document tamper-evident audit chain + review record |
| Checker rejects unsourced quantitative figures | Working — the isolated checker validates the evidence file for Office documents and returns "revise" on unsourced quantitative claims |
| Scratch-area semantics (draft writes redirect to scratch, human promotes) | Shipped — `/promote` command |
| Consent gate (pre-action summary that blocks until approved) | Shipped — `/consent` toggle; when enabled, the agent waits for approve / decline / exclude before each model call |
| Versioned memory (snapshots, diff, rollback) | Shipped — `/memory-history`, `/memory-rollback`, `/memory-diff` |
| Data connectors (plugin framework for external data sources) | Framework shipped — sample EDGAR connector included |
| Render→look→fix orchestration for Office documents | Shipped — `src/document/rlf_orchestrator.ts` |
| Live-draft demo (real tool run, not replayed fixtures) | Shipped — `npm run demo:ic-memo:live` drives the real evidence tracker + audit chain + OfficeCLI end-to-end (8/8) |
| Word-comment lineage (endnote form) | Shipped — `evidence finalize` appends a "Lineage & Sources" appendix to the .docx (SPEC §8.1) |
| Compaction consent gate | Shipped — compaction proposes, surfaces, and applies only if approved; full history saved first (SPEC §7.3) |
| Episodic examples store | Shipped — promote a praised deliverable; loaded as episodic memory in the consent gate (SPEC §7.4) |
| Drift detection | Shipped — `expected-structure.json` + halt before drafting if a source structure changed (SPEC §12.4) |
| DMS export framework | Shipped — SharePoint + NetDocuments adapters + `dms_export` tool; endpoints configured per engagement (SPEC §9.4) |
| Mid-tier data handling | Configurable — the workflow's sensitivity tier determines how each turn is handled (SPEC §11.2) |
| Background service login autostart | Shipped — autostart commands + system plist (SPEC §4.1) |
| Signed update infra | Shipped — Ed25519 sign + keypair mint; the production signing key is the owner's secret (SPEC §19) |
| Desktop app (Electron: chat, context panel, document preview, approvals) | Working, unsigned build |

## Data handling

Be precise: Quiver does not bake in a model endpoint. The operator configures an OpenAI-compatible endpoint via `LLM_API_BASE_URL`. When a cloud endpoint is used, prompt and file content sent in a request reaches that provider. Local model endpoints are supported and can be configured where an engagement requires it. Memory, sessions, documents, and the audit log live in files on your machine. Web research tools call external services only when used. There is no telemetry.

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

Key modules: agent loop with approval gates (`src/agent.ts`), context assembly,
model adapters per model family, security layer (command classifier, path sandbox,
macOS seatbelt, permissions store), isolated checker for verification, hash-chained
audit log, Office document tool (OfficeCLI), web research tools, and an Electron
desktop app sharing the same memory and sessions as the CLI.

See [`docs/architecture.md`](docs/architecture.md) for detail and
[`docs/advanced.md`](docs/advanced.md) for developer-oriented capabilities
(external tool servers, GitHub tooling, runtime tool creation, subagents, cloud folder sync)
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
`LLM_API_KEY` powers the primary LLM and vision adapters; `PARALLEL_API_KEY`
(optional) powers web research. API keys can be stored in the OS keychain. Quiver
is provider-agnostic — no model name, base URL, or API key is baked into the source;
set `LLM_API_BASE_URL` and `LLM_MODEL_NAME` in `.env` to point at any
OpenAI-compatible endpoint.

## Development

```bash
npm test            # Checker-owned acceptance contract — must stay green
npx tsc --noEmit    # Definition of done: clean typecheck
npm run demo:ic-memo # Flagship workflow + acceptance checks
```

The acceptance contract (`tests/spec_acceptance_tests.ts`) is a single checker-owned
file of behavioral assertions (re-run `npm test` for the live count). It verifies both spec compliance and that modules
are actually wired into the agent loop and tools — not just that the code exists.
`npm test` is the only live verdict — re-run it before trusting any status text.
See `tests/ACCEPTANCE_CONTRACT.md` and `docs/testing.md`.

Commercial positioning and public claims are governed by a capability truth table
maintained in the Conviction Studio engagement repository; this README's capability
status section mirrors it and must stay consistent.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [ATTRIBUTION.md](ATTRIBUTION.md).
