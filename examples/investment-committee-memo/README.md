# Investment committee memo — flagship example workflow

> **Illustrative workflow — synthetic data.** Every company, figure, filing,
> transcript, and transaction in this example is fabricated. Nothing here
> describes a real business.

This example shows an end-to-end document workflow with evidence discipline:
a "Project Alder" investment committee memo is rendered to `.docx`, every
figure in it is tracked in a source registry with an explicit relationship
(`sourced` / `derived` / `estimate` / `unresolved`), and a set of machine
acceptance checks verifies the output before it is handed to a human reviewer
— including re-reading the actual Excel cells behind the memo's numbers.

## Run it

```bash
npm run demo:ic-memo        # build memo + evidence artifacts, run acceptance checks
npm run export:website-demo # copy shareable artifacts into website-export/ (after the demo)
```

Requirements: Node + the repo's `node_modules` (`npm install`), and the
`officecli` binary on `PATH`. **No credentials, no network access, no API
keys.** All inputs are committed fixtures; the run is deterministic (static
as-of dates, no wall-clock timestamps in the artifacts).

Outputs land in `output/` (gitignored):

| File | What it is |
| --- | --- |
| `Project_Alder_IC_Memo.docx` | The memo: title, six sections, financial-overview table (Metric / Value / Source / Status), footer label on every page |
| `Project_Alder_Evidence.json` | Evidence map: every claim with its sources, relationship, and review status |
| `Project_Alder_Evidence.html` | Human-readable evidence report (screenshotted to `screenshots/`) |
| `Project_Alder_Review_Checklist.md` | Reviewer checklist: 3 flagged figures with what to verify, plus the standing checks |
| `Project_Alder_Run_Record.json` | Inputs with SHA-256 hashes, sources used/excluded, tool versions, `draft_for_review` status |

Committed reference copies of the JSON/Markdown/HTML artifacts and the docx
live in `expected/` for comparison.

## What is real vs. illustrative

**Real (exercised live on every run):**

- The `.docx` is genuinely built by `officecli` from the committed template
  and fixture content, and validated against the OpenXML schema.
- **Cell-level lineage for Excel-sourced figures.** The acceptance checks
  re-read `inputs/Model_v12.xlsx` through `officecli` and compare the actual
  cell values to the memo's claims: revenue ($48.2 million) is read from
  `RevenueBuild!C8` (a live `SUM` formula), and the EBITDA margin (22.4%) is
  recomputed from `P&L!B8` and `P&L!B4`. If you edit the workbook, the run
  fails.
- All eight acceptance checks read the generated artifacts back (via
  `officecli query`/`validate` and the filesystem); none of them trust the
  writer's own bookkeeping.
- The export script's hygiene checks (no absolute local paths, no
  secret-looking strings, label present in every artifact).

**Illustrative (fixture replay):**

- The drafting step is replayed from fixtures
  (`fixtures/memo-content.json` + `fixtures/sources.json`). In engagements an
  AI model drafts the memo content under the same evidence rules; this demo
  deliberately replays a pre-drafted memo through the same rendering,
  evidence, and acceptance pipeline so the demonstration is reproducible and
  deterministic. **No AI drafted the committed fixture content.**
- All input documents (`inputs/`) are synthetic: the operating model, the
  10-Q excerpt, the earnings-call transcript, the internal note, and the
  comps CSV were authored as fixtures.

## Explicit limitations

- **Cell-level lineage is demonstrated only for the Excel-sourced figures.**
  Filing, transcript, note, and CSV references are section- or page-level:
  the checks confirm the registry entry and its excerpt, but do not parse
  those documents to re-derive the figures.
- The pipeline emits a **draft only** (`review_status: draft_for_review`);
  `reviewer_decision` is `null` on every claim. Human review is the last
  step of the real workflow and is out of scope here.
- Retrieval is static (`retrieval.mode: static` in `workflow.yaml`): the demo
  does not fetch anything. A live engagement would add retrieval and an AI
  drafting step in front of the same pipeline.
- The `.docx` binary itself may differ byte-for-byte between runs (archive
  packaging); the JSON/HTML/Markdown artifacts are byte-stable.
- `tool_versions` in the run record reflects the environment that produced
  it, so your `expected/` comparison may differ on that field if your
  `officecli`/Node versions differ.

## The acceptance checks

Defined in `acceptance-checklist.yaml`, implemented one-for-one in
`scripts/checks.ts` (the run fails if the two ever drift apart):

1. `sections-present` — all six sections appear as Heading 1 in order, read
   back via `officecli query`.
2. `docx-validates` — `officecli validate` passes.
3. `no-placeholder-text` — no `{{...}}`, TODO/TBD, or lorem text anywhere in
   the document, tables, or footer.
4. `claims-have-sources` — every quantitative claim cites an approved source
   or is explicitly flagged/unresolved; nothing cites an excluded source.
5. `excel-cell-verification` — actual workbook cells re-read and compared
   (the derived margin is recomputed from both cells).
6. `table-matches-evidence` — the docx financial table and the evidence map
   match bidirectionally.
7. `unresolved-in-checklist` — unresolved claims appear in the review
   checklist.
8. `run-record-complete` — the run record lists every input with a matching
   SHA-256 hash and records the excluded source with its reason.

## Layout

```
workflow.yaml              workflow contract (purpose, inputs, policies, outputs)
acceptance-checklist.yaml  machine-readable checks list
inputs/                    synthetic fixtures incl. Model_v12.xlsx (committed binary)
template/                  firm-style .docx shell: styles, standing title, labeled footer
fixtures/                  sources.json (registry incl. 1 excluded source), memo-content.json
scripts/                   lib.ts, build-fixtures.ts, run-demo.ts, checks.ts,
                           artifacts.ts, export-website-demo.ts
expected/                  committed reference outputs
screenshots/               evidence-report.png (regenerated by the run, best-effort)
output/                    runtime output (gitignored)
website-export/            hygiene-checked copies for the public site (committed)
```

To regenerate the committed binaries (`inputs/Model_v12.xlsx`,
`template/ic-memo-template.docx`) after changing figures:

```bash
npx tsx examples/investment-committee-memo/scripts/build-fixtures.ts
```

The source figures are chosen so that the memo matches the public site:
FY2025 revenue $48.2m (`RevenueBuild!C8`), EBITDA margin 22.4%
(`P&L!B8 ÷ P&L!B4`), growth 17.8% vs. the prior period in the synthetic 10-Q,
nine sources reviewed, one excluded, three figures flagged for verification.
