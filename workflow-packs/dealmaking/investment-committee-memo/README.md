# Dealmaking & Diligence — Investment Committee Memo Pack

**Maturity**: `demo-ready` (Executable flagship reference implementation)  
**Family**: `dealmaking`  
**Workflow**: `investment-committee-memo`

## Overview

This workflow pack generates an Office-ready Investment Committee (IC) Memorandum from template files, financial models, SEC filings, management call transcripts, and internal diligence notes.

## Common Contract Files

- `workflow.yaml` — Declarative workflow definition and deliverable rules
- `acceptance-checklist.yaml` — Machine-readable acceptance checks
- `template/` — Firm template (`ic-memo-template.docx`)
- `sample-inputs/` — Fixture inputs (operating model, filing excerpts, transcripts)
- `expected-output/` — Canonical verified outputs and evidence records

## Execution

Run the flagship IC memo demonstration from the workspace root:

```bash
npm run demo:ic-memo
```
