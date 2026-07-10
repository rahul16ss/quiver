# Project Alder (synthetic company) — Review Checklist

> Illustrative workflow — synthetic data · Draft for review

Workflow: investment-committee-memo v1.0.0 · as of 2025-06-30
Review status: draft_for_review — reviewer_decision is null on every claim until sign-off.

## Figures to verify (3 flagged)

### Needs analyst review

- [ ] **CLM-005** — "management guidance implies EBITDA margin expansion of roughly 150-200 bps by FY2027" (relationship: derived; sources: SRC-005 (Management's discussion and analysis (MD&A)))
  - What to verify: Derived from qualitative MD&A language; the 150-200 bps quantification is an analyst reading, not a stated figure. An analyst must confirm the margin bridge with management before the committee relies on it.

### Flagged

- [ ] **CLM-007** — "comparable vertical-software transactions cleared at 4.9x-6.8x EV/Revenue" (relationship: sourced; sources: SRC-008 (rows 2-9))
  - What to verify: Verify comparability: the vendor export mixes deal sizes and end markets; confirm which transactions are genuinely comparable before quoting the range to the committee.

### Unresolved

- [ ] **CLM-006** — "the base case assumes net leverage of 4.0x at close" (relationship: unresolved; sources: SRC-007 (Financing assumptions))
  - What to verify: Assumption only. The internal model note states it is pending lender feedback and not yet confirmed. Must be resolved with financing counterparties before committee sign-off.

## Standing checks (enforced automatically on every run)

- Required sections present in generated docx (`sections-present`)
- Document passes officecli validate (`docx-validates`)
- No placeholder text in the docx (`no-placeholder-text`)
- Every quantitative claim is sourced or flagged (`claims-have-sources`)
- Excel cell-level lineage verified (`excel-cell-verification`)
- Financial table matches evidence map (`table-matches-evidence`)
- Unresolved items appear in review checklist (`unresolved-in-checklist`)
- Run record lists inputs, hashes, and exclusions (`run-record-complete`)

## Excluded sources

- SRC-010 — Unattributed industry blog post on vertical-software multiples: Unattributed source: no named author or publisher and no verifiable methodology. Fails the workflow source policy, so it was excluded from drafting and no claim may cite it.

## Sources reviewed (9)

- SRC-001 — Project Alder operating model v12 — revenue build (excel_model; RevenueBuild!C8)
- SRC-002 — Project Alder operating model v12 — P&L, FY2025 EBITDA (excel_model; P&L!B8)
- SRC-003 — Project Alder operating model v12 — P&L, FY2025 revenue (excel_model; P&L!B4)
- SRC-004 — Synthetic 10-Q excerpt — condensed income statement (filing; Condensed income statement)
- SRC-006 — Synthetic Q2 FY2025 earnings-call transcript excerpt (transcript; Section 7 — Q&A: customer base, page 7)
- SRC-005 — Synthetic 10-Q excerpt — MD&A (filing; Management's discussion and analysis (MD&A))
- SRC-007 — Internal model note — leverage assumptions (internal_note; Financing assumptions)
- SRC-008 — Comparable transactions export (comps.csv) (vendor_export; rows 2-9)
- SRC-009 — Synthetic Q2 FY2025 earnings-call transcript excerpt — retention (transcript; Section 4 — CFO remarks: retention, page 4)

Cell-level lineage applies to the Excel-sourced figures only; filing, transcript, note, and CSV references are section- or page-level. All data is synthetic.
