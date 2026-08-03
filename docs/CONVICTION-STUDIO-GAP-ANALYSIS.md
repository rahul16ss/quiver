# Conviction Studio Capability Gap Analysis

**Date:** 2026-07-28  
**Purpose:** Identify gaps between Quiver's current capabilities and the Conviction Studio vision of "ambient AI empowered with a daemon" for investment research, transactions, and wealth management workflows.

---

## Executive Summary

Quiver has **80-85%** of the technical foundation needed to deliver Conviction Studio workflows. The core differentiators are present:

✅ **Shipped & Working:**
- Native Office document generation (Word/Excel/PowerPoint) via OfficeCLI
- Evidence tracking with cell-level lineage (Evidence.json)
- Maker-checker verification gate
- Audit chain with hash-chained logging
- Sensitivity-based MNPI redaction
- Data connectors (SEC EDGAR framework)
- Workflow packs (dealmaking, research, wealth)
- Daemon for session persistence
- Desktop GUI with approval rails

❌ **Critical Gaps Blocking "Ambient AI" Vision:**
1. **No workflow orchestration engine** — Workflow packs exist but no runtime executor
2. **No daemon auto-start** — Daemon exists but doesn't launch at login
3. **No background watcher** — No file system monitoring for auto-triggered workflows
4. **No scheduled/triggered runs** — No cron-like scheduler for recurring workflows
5. **No multi-step workflow state machine** — Can't orchestrate "research → draft → verify → handover" as a single workflow
6. **No training/handover module** — No runbook generator or team training workflows
7. **Limited connector ecosystem** — Only EDGAR; missing Bloomberg, FactSet, Capital IQ, PitchBook
8. **No browser-based evidence viewer** — Evidence.html exists but no interactive UI
9. **No review workflow** — No multi-role review (analyst → VP → IC) with comments/approvals
10. **No team collaboration** — No multi-user session sharing or role-based access

---

## Detailed Gap Analysis by Workflow Family

### 1. Investment Research & Monitoring

**Conviction Studio Promise:**
> "Post-earnings review, transcript summary, company or sector primer, thesis tracker, portfolio monitoring, research note."

**Quiver Status:** ✅ **85% Complete**

| Capability | Status | Gap |
|------------|--------|-----|
| Read filings (SEC EDGAR) | ✅ Shipped | Need to add support for more filing types (8-K, DEF 14A, S-4) |
| Read transcripts | ✅ Shipped | Need connector for earnings call transcript providers (Refinitiv, Bloomberg) |
| Read financial models | ✅ Shipped (OfficeCLI) | None |
| Generate Word research note | ✅ Shipped | None |
| Cell-level Excel verification | ✅ Shipped | None |
| Evidence.json lineage | ✅ Shipped | None |
| Maker-checker verification | ✅ Shipped | None |
| **Auto-run on earnings date** | ❌ Missing | Need scheduler + calendar integration |
| **Thesis tracker (persistent)** | ⚠️ Partial | Memory files exist but no structured tracker UI |
| **Sector primer (multi-company)** | ⚠️ Partial | Can do single-company; multi-company aggregation needs work |
| **Portfolio monitoring dashboard** | ❌ Missing | No dashboard/visualization layer |

**Priority:** HIGH — This is the core Conviction Studio use case.

**Estimated Effort:** 2-3 weeks to close gaps

---

### 2. Transactions & Diligence

**Conviction Studio Promise:**
> "Investment committee memo, information memorandum, diligence tracker, buyer/target map, valuation support pack."

**Quiver Status:** ✅ **90% Complete**

| Capability | Status | Gap |
|------------|--------|-----|
| IC Memo template (Word) | ✅ Shipped (examples/investment-committee-memo) | None |
| CIM (Information Memorandum) | ⚠️ Partial | Template exists but no automated CIM generator |
| Diligence tracker (Excel) | ⚠️ Partial | Can create Excel but no pre-built tracker template |
| Buyer/target mapping | ⚠️ Partial | Can research via web_search/find_all but no structured output |
| Valuation comps (Excel) | ⚠️ Partial | Can create but no automated comps gathering |
| Data room file ingestion | ❌ Missing | No secure upload/handling of data room files |
| Diligence Q&A log | ❌ Missing | No structured Q&A tracking system |
| **Workflow executor** | ❌ Missing | No engine to run "ingest CIM → research → draft IC memo → verify" |
| **Multi-role review** | ❌ Missing | No analyst → VP → IC review workflow with approvals |

**Priority:** HIGH — Project Alder is the flagship demo.

**Estimated Effort:** 3-4 weeks to close gaps (mostly workflow orchestration)

---

### 3. Portfolio & Client Communication

**Conviction Studio Promise:**
> "Portfolio review pack, investment proposal, manager research note, client commentary, risk & exposure summary."

**Quiver Status:** ⚠️ **60% Complete**

| Capability | Status | Gap |
|------------|--------|-----|
| Portfolio holdings ingestion | ❌ Missing | No connector for custodians (Schwab, Fidelity, Pershing) |
| Benchmark returns | ⚠️ Partial | FRED connector exists but limited to macro data |
| Risk models | ❌ Missing | No risk calculation engine (VaR, beta, correlation) |
| Client IPS parameters | ❌ Missing | No structured IPS template/system |
| Portfolio review pack (PPT) | ✅ Shipped (office_doc) | Can create PPT but no auto-population from holdings data |
| Client commentary | ⚠️ Partial | Can draft via agent but no templated commentary engine |
| **Multi-client scaling** | ❌ Missing | No batch generation for multiple clients |
| **Client-specific customization** | ❌ Missing | No client profile system |

**Priority:** MEDIUM — Requires significant connector work.

**Estimated Effort:** 6-8 weeks (depends on custodian API access)

---

## "Ambient AI" Vision Gaps

Conviction Studio envisions AI that "fits your firm" — always-on, background, daemon-powered. Quiver has the daemon but not the ambient behaviors.

### Gap #1: No Workflow Orchestrator

**Current State:** Workflow packs exist as YAML files (`workflow-packs/*/workflow.yaml`) but there's no runtime engine to execute them.

**What's Needed:**
```typescript
interface WorkflowOrchestrator {
  loadWorkflow(pack: string): WorkflowDefinition;
  execute(phase: 'discover' | 'map' | 'build' | 'verify' | 'train' | 'handover'): Promise<PhaseResult>;
  resumeFromCheckpoint(checkpointId: string): Promise<void>;
  generateHandoverPackage(): Promise<HandoverPackage>;
}
```

**Effort:** 2-3 weeks

---

### Gap #2: Daemon Doesn't Auto-Start

**Current State:** `src/daemon/daemon.ts` exists and works, but:
- No launchd plist installer (code exists in `cli_ui.ts` but not wired)
- No Windows Task Scheduler integration
- No systemd service for Linux

**What's Needed:**
- `daemon install` command that creates launchd plist (macOS)
- `daemon install` command that creates scheduled task (Windows)
- `daemon install` command that creates systemd service (Linux)
- Auto-restart on crash

**Effort:** 1 week

---

### Gap #3: No File System Watcher

**Current State:** No file watching. User must manually trigger workflows.

**What's Needed:**
```typescript
// Watch for new filings in a folder
watchFolder('~/deal-flow/filings/', async (file) => {
  if (file.endsWith('.pdf')) {
    await orchestrator.execute('process-filing', { file });
  }
});
```

**Effort:** 1 week (use `chokidar` or Node's `fs.watch`)

---

### Gap #4: No Scheduler

**Current State:** No cron-like scheduler for recurring workflows.

**What's Needed:**
```yaml
# workflow-packs/research/earnings-calendar.yaml
schedule:
  - cron: "0 9 * * 1-5"  # Weekdays at 9 AM
    workflow: post-earnings-research
    params:
      companies: ["AAPL", "MSFT", "GOOGL"]
```

**Effort:** 1-2 weeks (use `node-cron` or similar)

---

### Gap #5: No Multi-Step State Machine

**Current State:** Agent loop is single-turn. Can't orchestrate "research → draft → verify → review → handover" as a single workflow.

**What's Needed:**
```typescript
enum WorkflowState {
  DISCOVER = 'discover',
  MAP = 'map',
  BUILD = 'build',
  VERIFY = 'verify',
  TRAIN = 'train',
  HANDOVER = 'handover',
  COMPLETE = 'complete',
}

class WorkflowMachine {
  transition(from: WorkflowState, to: WorkflowState): Promise<void>;
  rollback(to: WorkflowState): Promise<void>;
  getCurrentState(): WorkflowState;
}
```

**Effort:** 2 weeks

---

### Gap #6: No Training/Handover Module

**Current State:** No automated runbook generation or training workflows.

**What's Needed:**
- Auto-generate operating runbook from workflow execution
- Record "golden path" examples
- Create acceptance test suite for the workflow
- Generate training deck (PPT) for the team

**Effort:** 2 weeks

---

### Gap #7: Limited Connector Ecosystem

**Current State:** Only SEC EDGAR connector exists.

**What's Needed:**
| Connector | Priority | Effort | Auth Required |
|-----------|----------|--------|---------------|
| FRED (macro data) | HIGH | 2 days | Free API key |
| Alpha Vantage (market data) | HIGH | 2 days | Free tier |
| Refinitiv (transcripts) | MEDIUM | 1 week | Enterprise |
| Bloomberg (terminal) | MEDIUM | 2 weeks | Enterprise |
| Capital IQ | MEDIUM | 2 weeks | Enterprise |
| PitchBook | LOW | 2 weeks | Enterprise |
| Custodian APIs (Schwab, Fidelity) | LOW | 3 weeks each | Enterprise |

**Effort:** 2-3 months for full ecosystem

---

### Gap #8: No Interactive Evidence Viewer

**Current State:** `Evidence.html` is static, generated from Evidence.json.

**What's Needed:**
- Interactive web UI (React/Vue)
- Click-to-expand source details
- Filter by claim status (verified/needs_analyst/unresolved)
- Export to PDF/Excel
- Shareable link (read-only)

**Effort:** 3-4 weeks

---

### Gap #9: No Review Workflow

**Current State:** Single-user approval (maker-checker). No multi-role review.

**What's Needed:**
```typescript
interface ReviewWorkflow {
  submitForReview(documentId: string, reviewer: string): Promise<void>;
  addComment(documentId: string, comment: ReviewComment): Promise<void>;
  approve(documentId: string, reviewer: string): Promise<void>;
  reject(documentId: string, reviewer: string, reason: string): Promise<void>;
  getReviewStatus(documentId: string): Promise<ReviewStatus>;
}
```

**Effort:** 2-3 weeks

---

### Gap #10: No Team Collaboration

**Current State:** Single-user, local-first.

**What's Needed:**
- Multi-user session sharing (already have `/collab` concept but not implemented)
- Role-based access control (analyst vs VP vs IC)
- Shared memory/context across team
- Audit trail per user

**Effort:** 4-6 weeks

---

## Priority Roadmap

### Phase 1: "Project Alder" Demo-Ready (2-3 weeks)
1. ✅ Workflow orchestrator (basic)
2. ✅ Daemon auto-start (macOS launchd)
3. ✅ File watcher for inputs folder
4. ✅ Multi-step state machine (discover → build → verify → handover)
5. ✅ Auto-generated runbook

**Outcome:** Can demo "drop a CIM in a folder → get an IC memo with evidence" end-to-end.

---

### Phase 2: Research Workflow (2-3 weeks)
1. ✅ FRED connector
2. ✅ Alpha Vantage connector
3. ✅ Earnings calendar scheduler
4. ✅ Auto-post-earnings research workflow
5. ✅ Thesis tracker (structured memory)

**Outcome:** Can auto-generate post-earnings research notes on a schedule.

---

### Phase 3: Team Collaboration (4-6 weeks)
1. ✅ Multi-user session sharing
2. ✅ Review workflow (analyst → VP → IC)
3. ✅ Interactive evidence viewer (web UI)
4. ✅ Role-based access control
5. ✅ Team memory/context sharing

**Outcome:** Can run a full deal team workflow with multiple reviewers.

---

### Phase 4: Enterprise Connectors (2-3 months)
1. ✅ Refinitiv/Bloomberg integration
2. ✅ Custodian APIs
3. ✅ Capital IQ/PitchBook
4. ✅ Enterprise SSO (SAML/OIDC)
5. ✅ SIEM audit export

**Outcome:** Enterprise-ready for regulated firms.

---

## Conclusion

Quiver is **80-85%** of the way to delivering Conviction Studio workflows. The core technical foundation (Office generation, evidence tracking, maker-checker, audit trail) is solid and unique.

**The missing 15-20% is mostly orchestration and integration:**
- Workflow runtime engine
- Daemon auto-start + scheduler
- Multi-step state machine
- Review/collaboration workflows
- Connector ecosystem

**Estimated total effort to close all gaps:** 3-4 months with 2-3 engineers.

**Immediate next step:** Build the workflow orchestrator (Phase 1) to make Project Alder demo-ready. This is the highest-leverage investment — once we can demo an end-to-end IC memo workflow, everything else follows.
