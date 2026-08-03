# Quiver Capabilities & Technical Feature Specification

This document is the current technical capability matrix for the Quiver workflow engine.
Statuses distinguish runnable foundations from capabilities that still require engagement
configuration or additional hardening.

---

## Technical Feature Matrix

| Feature / Area | Status | Spec / Code Reference |
| :--- | :--- | :--- |
| **Native Office Generation** | Working (`.docx`, `.xlsx`, `.pptx`) | `src/document/` |
| **Evidence Tracking & Lineage** | Working | `Evidence.json`, verification rail |
| **Reviewer Sign-off & Override Flow** | Shipped | Desktop GUI & audit chain |
| **Quantitative Checker Validation** | Working | `src/checker/` |
| **Scratch-Area Draft Isolation** | Shipped | `/promote` command |
| **Pre-Action Consent Gate** | Shipped | `/consent` toggle |
| **Versioned Memory Snapshots** | Shipped | `/memory-history`, `/memory-diff` |
| **Data Connector Framework** | Framework shipped | Sample EDGAR connector |
| **Render-Look-Fix Orchestrator** | Shipped | `src/document/rlf_orchestrator.ts` |
| **Word Comment Lineage Appendix** | Shipped | `evidence finalize` |
| **Compaction Consent Gate** | Shipped | SPEC §7.3 |
| **Episodic Examples Store** | Shipped | SPEC §7.4 |
| **Drift Detection & Guardrails** | Shipped | SPEC §12.4 |
| **DMS Export Framework** | Shipped | SharePoint + NetDocuments adapters |
| **Mid-Tier Data Sensitivity Redaction** | Configurable | SPEC §11.2 |
| **Daemon Autostart System Plist** | Shipped | SPEC §4.1 |
| **Signed Desktop Update Infrastructure** | Shipped | Ed25519 signatures |
| **Electron Desktop Application** | Working | `ui/` (unsigned build) |
| **Ambient Workflow Orchestrator** | Foundation | `src/workflow/orchestrator.ts`; agent callback and verification hardening pending |
| **Cron Workflow Scheduler** | Foundation | `src/workflow/scheduler.ts`; daemon wiring is present, production hardening pending |
| **File-Triggered Watcher System** | Foundation | `src/workflow/watcher.ts`; Windows watcher semantics are pending |
| **Multi-Role Review Chain** | Foundation | `src/workflow/review.ts`; final deliverable gate hardening pending |
| **Handover & Runbook Generator** | Foundation | `src/workflow/handover.ts` |
| **Workflow Pack Library** | 3 runnable demos + 9 scaffolds | `workflow-packs/`; only the three demo packs are runnable today |
| **Governed Plain-Text PKM System** | To be built in future | `docs/knowledge-and-storage.md`, `src/memory/` |
| **Microsoft 365 Native Storage Engine** | To be built in future | `docs/knowledge-and-storage.md`, `src/export/dms.ts` |
