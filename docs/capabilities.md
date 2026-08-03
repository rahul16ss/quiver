# Quiver Capabilities & Technical Feature Specification

This document details the full technical capability matrix supported by the Quiver workflow engine.

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
| **Ambient Workflow Orchestrator** | Shipped | `src/workflow/orchestrator.ts` |
| **Cron Workflow Scheduler** | Shipped | `src/workflow/scheduler.ts` |
| **File-Triggered Watcher System** | Shipped | `src/workflow/watcher.ts` |
| **Multi-Role Review Chain** | Shipped | `src/workflow/review.ts` |
| **Handover & Runbook Generator** | Shipped | `src/workflow/handover.ts` |
| **Complete 12-Pack Sprint Library** | Shipped | `workflow-packs/` (Dealmaking, Research, Wealth) |
| **Governed Plain-Text PKM System** | To be built in future | `docs/knowledge-and-storage.md`, `src/memory/` |
| **Microsoft 365 Native Storage Engine** | To be built in future | `docs/knowledge-and-storage.md`, `src/export/dms.ts` |
