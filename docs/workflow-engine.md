# Quiver Workflow Engine & Ambient AI Architecture

Quiver's **Workflow Engine** enables autonomous, background ("ambient") document production pipelines tailored for financial firms (Private Equity, Hedge Funds, Wealth Management, Investment Banking).

It implements the full 6-phase lifecycle promised by Conviction Studio:
`discover → map → build → verify → train → handover`

---

## 1. Core Architecture & Lifecycle Phases

```
┌─────────────┐     ┌─────────┐     ┌──────────┐     ┌────────────┐     ┌──────────┐     ┌──────────────┐
│  DISCOVER   │  →  │   MAP   │  →  │  BUILD   │  →  │   VERIFY   │  →  │  TRAIN   │  →  │   HANDOVER   │
│ Validate    │     │ Section │     │ Model +  │     │ Acceptance │     │ Capture  │     │ Runbook +    │
│ inputs      │     │ data    │     │ Evidence │     │ & Lineage  │     │ insights │     │ Sign-off     │
└─────────────┘     └─────────┘     └──────────┘     └────────────┘     └──────────┘     └──────────────┘
```

1. **Discover**: Scans and validates available input files against the `allowed_inputs` declared in `workflow.yaml`.
2. **Map**: Maps document sections to source files and verifies data availability.
3. **Build**: Runs pre-build drift detection (`checkDrift`), generates document deliverables via OfficeCLI, and registers every quantitative claim using the `evidence` tool.
4. **Verify**: Evaluates document lineage against the `acceptance-checklist.yaml` and executes maker-checker checks.
5. **Train**: Captures operational context and decisions for firm-level memory.
6. **Handover**: Auto-generates a Markdown operating runbook (`<workflow>_Runbook.md`) and initializes the multi-role human review chain.

---

## 2. Trigger Mechanics & Ambient Autonomy

Workflows can be launched in three modes:

### Manual / On-Demand
Execute a workflow pack immediately via the CLI or REPL:
```bash
quiver workflow run investment-committee-memo
```
or inside the interactive REPL:
```text
/workflow run investment-committee-memo
```

### Cron Scheduler (`WorkflowScheduler`)
Set up recurring background executions. Stored in `~/.quiver/schedules.json` and executed by the daemon:
```bash
# Run every Monday at 8:00 AM
quiver workflow schedule investment-committee-memo --cron "0 8 * * 1"
```

### File System Watcher (`WorkflowWatcher`)
Monitor input folders (e.g. VDR drops, earnings release directories) and auto-trigger workflows upon file arrival:
```bash
quiver workflow watch post-earnings-evidence-pack --dir ./inbox --pattern "*.pdf"
```

---

## 3. Human-in-the-Loop Review System (`ReviewManager`)

Documents emitted by Quiver start in a `draft_for_review` state. The `ReviewManager` manages multi-role approval chains by family:

- **Dealmaking**: `analyst → vp → partner`
- **Research**: `analyst → senior_analyst → pm`
- **Wealth**: `analyst → advisor → cio`

Review status can be inspected and updated programmatically or via REPL commands.

---

## 4. Workflow Pack Layout

Every workflow pack lives under `workflow-packs/<family>/<pack-name>/` and contains:
- `workflow.yaml` — Declarative manifest detailing inputs, deliverable sections, review roles, and outputs.
- `acceptance-checklist.yaml` — Structural and numeric validation rules.
- `expected-structure.json` — Drift detection baseline file.
- `sample-inputs/` — Fixture inputs (models, transcripts, filings).
- `template/` — Deliverable template (`.docx`, `.xlsx`, `.pptx`).
