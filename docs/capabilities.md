# Quiver Capabilities & Technical Feature Specification

This document is the current technical capability matrix for the Quiver workflow engine.
Statuses distinguish runnable foundations from capabilities that still require engagement
configuration or additional hardening. The governing product principles are in
[principles.md](principles.md).

---

## Technical Feature Matrix

| Feature / Area | Status | Spec / Code Reference |
| :--- | :--- | :--- |
| **Native Office Generation** | Working (`.docx`, `.xlsx`, `.pptx`) | `src/tools/office_doc.ts` |
| **Evidence Tracking & Lineage** | Working; finalization is hard-gated on valid evidence | `src/evidence/`, `Evidence.json` |
| **Reviewer Sign-off & Override Flow** | Shipped | Desktop GUI & audit chain |
| **Quantitative Checker Validation** | Working | `src/subagents/checker.ts` |
| **Scratch-Area Draft Isolation** | Shipped | `/promote` command |
| **Pre-Action Consent Gate** | Shipped | `/consent` toggle |
| **Versioned Memory Snapshots** | Shipped | `/memory-history`, `/memory-diff` |
| **Data Connector Framework** | Framework shipped; connectors are engagement-provided | `src/connectors/framework.ts`, `data_query` |
| **Render-Look-Fix Orchestrator** | Module present; live drafting uses the manual `office_doc` RLF loop described in the system prompt | `src/document/rlf_orchestrator.ts`, `skills/system-prompt/SKILL.md` |
| **Word Comment Lineage Appendix** | Appendix / endnote-style lineage shipped; inline Word `w:comment` balloons not implemented | `src/document/word_lineage.ts`, `evidence finalize` |
| **Compaction Consent Gate** | Shipped | SPEC §7.3 |
| **Episodic Examples Store** | Shipped | SPEC §7.4 |
| **Drift Detection & Guardrails** | Shipped | SPEC §12.4 |
| **DMS Export Framework** | Integration shape shipped; engagement auth required | SharePoint + NetDocuments adapters |
| **Mid-Tier Data Sensitivity Redaction** | Configurable | SPEC §11.2 |
| **Daemon Autostart** | macOS launchd and Windows Task Scheduler support shipped; live Windows validation remains an owner step | SPEC §4.1 |
| **Signed Desktop Update Infrastructure** | Foundation shipped (Ed25519 verify); production pubkey + signed manifests are release-process work — unsigned Electron builds today | `src/updates.ts`, `docs/release.md` |
| **Electron Desktop Application** | Working | `ui/` (unsigned build) |
| **Ambient Workflow Orchestrator** | Working foundation; verify phase is acceptance-checked | `src/workflow/orchestrator.ts` |
| **Cron Workflow Scheduler** | Working foundation; platform installation is engagement-specific | `src/workflow/scheduler.ts` |
| **File-Triggered Watcher System** | Working foundation; live Windows customer validation remains an owner step | `src/workflow/watcher.ts` |
| **Multi-Role Review Chain** | Foundation; engagement-specific reviewer policy remains | `src/workflow/review.ts` |
| **Handover & Runbook Generator** | Foundation | `src/workflow/handover.ts` |
| **Workflow Pack Library** | 3 runnable demos + 10 scaffolds | `workflow-packs/`; only the three demo packs are runnable today |
| **Governed Plain-Text PKM System** | Foundations shipped; review queue and workflow episodic harvest are active | `docs/knowledge-and-storage.md`, `src/memory/` |
| **Microsoft 365 Native Storage Engine** | Standards-based integration shape; engagement auth and tenant policy required | `docs/knowledge-and-storage.md`, `src/export/dms.ts` |
