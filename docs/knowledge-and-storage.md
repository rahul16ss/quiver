# Knowledge Management & Microsoft 365 Native Storage Architecture

> **Status discipline**: This document specifies the target architecture for client engagements. Foundations exist in `src/memory/` and `src/export/dms.ts`. Complete end-to-end firm PKM systems and production M365 storage connectors are built per customer engagement (see `docs/capabilities.md`). The governing principles are in [docs/principles.md](principles.md).

This document specifies Quiver's architectural approach to:
1. **Personal & Institutional Knowledge Management (PKM)** in full harmony with AI context transparency.
2. **Microsoft 365 Native Storage Integration** (SharePoint, OneDrive, Graph API, OfficeCLI).

---

## Part 1: Personal & Institutional Knowledge Management (PKM)

### Architectural Rationale
Traditional enterprise AI knowledge management relies on opaque Vector RAG (retrieval-augmented generation). Files are converted to vector embeddings, stored in a third-party vector database, and injected into context based on semantic similarity search.

This "black-box context injection" violates Quiver’s core governance principles:
- **"Control context every time"**: The analyst must inspect and approve all memory, facts, and sources passed to the model before execution.
- **"Sources you can inspect"**: Every quantitative figure and qualitative assertion must trace to an inspectable source.
- **"User-owned plain text"**: Memory must live in local, human-readable, version-controlled files (`.md`/`.txt`) on the user's machine.

Quiver replaces black-box RAG with a **Governed Plain-Text Knowledge Architecture**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    LAYER 4: REPL VERSIONING & RECOVERABILITY                │
│            /memory-history · /memory-diff · /memory-rollback                │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────┴──────────────────────────────────────┐
│                    LAYER 3: CONTEXT CONSENT GATE & HUD                      │
│     Analyst approves exact memory files + facts injected before model run   │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────┴──────────────────────────────────────┐
│                    LAYER 2: CURATED PLAIN-TEXT KNOWLEDGE                    │
│     Core Memory (core.md) · House Style · Sector Comps · Review Rules       │
└──────────────────────────────────────▲──────────────────────────────────────┘
                                       │
┌──────────────────────────────────────┴──────────────────────────────────────┐
│                    LAYER 1: EPISODIC WORKFLOW HARVESTING                    │
│     Post-workflow fact extraction → /memory review queue                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Implementation Status Matrix: PKM

| Component / Feature | Rationale & Design | Implementation Status | Location in Codebase |
| :--- | :--- | :--- | :--- |
| **Plain-Text Memory Store** | Human-readable Markdown/text files owned by the user. | **SHIPPED** | `~/.quiver/memory/core.md`, `src/paths.ts` |
| **Versioned Snapshots** | Git-style version history, diffing, and rollback for memory files. | **SHIPPED** | `src/memory/versioned.ts`, `/memory-history`, `/memory-diff`, `/memory-rollback` |
| **Fact Provenance Schema** | Each fact carries source workflow, as-of date, confidence, and review status. | **SHIPPED** | `src/memory/schema.ts` (US-12.1) |
| **Pre-Action Consent Gate** | Displays exact memory, tools, and context passed to model prior to turn. | **SHIPPED** | `src/security/consent_gate.ts`, `/consent` |
| **Memory Review Queue** | Interactive queue for reviewing and approving pending extracted facts. | **SHIPPED** | `/memory review` |
| **Episodic Workflow Harvester** | Extracts explicitly labelled candidate facts when a workflow completes and places them in the pending review queue. | **SHIPPED (bounded)** | `src/memory/episodic_harvester.ts`, `src/workflow/orchestrator.ts` |

---

## Part 2: Microsoft 365 Native Storage Integration

### Architectural Rationale
Financial institutions use Microsoft 365 (SharePoint Online, OneDrive for Business, Microsoft Graph, Entra ID) as their primary document management and compliance boundary.

Quiver uses **OfficeCLI** as its native document generation engine. OfficeCLI produces standard **ECMA-376 OpenXML** files (`.docx`, `.xlsx`, `.pptx`). By keeping document generation local and emitting pure OpenXML, Quiver is designed for standards-based Microsoft 365 storage workflows without requiring browser add-ins or proprietary webview wrappers. Microsoft 365 policies, sync behavior, and co-authoring rules still apply.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          LOCAL WORKSTATION (MAC / WINDOWS)                  │
│                                                                             │
│   Quiver Harness  ──(drives)──>  OfficeCLI  ──(writes)──>  Local Sync Folder │
│                                                          (~/SharePoint/...) │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │ (fs events)
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MICROSOFT ONEDRIVE SYNC CLIENT                       │
│    Detects atomic file write → Computes Delta Sync → Emits M365 Webhooks     │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │ (HTTPS / Graph API)
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MICROSOFT 365 CLOUD STORAGE                        │
│   SharePoint Document Library · Microsoft Graph · Version History · DLP    │
└──────────────────────────────────────────────┬──────────────────────────────┘
```

#### Why OfficeCLI fits M365 workflows:
1. **OpenXML Standards Compliance**: Files generated by OfficeCLI are standard Word/Excel/PowerPoint documents. When synced to SharePoint, Microsoft Purview DLP rules, Sensitivity Labels, and Microsoft Graph Search indexing apply automatically.
2. **OneDrive Sync Engine Compatibility**: Analysts work in local synchronized SharePoint libraries. On Windows, the sync client can briefly lock files, so Quiver retries transient sharing violations and does not claim to bypass co-authoring or conflict-copy behavior.
3. **Native Office Desktop Co-Authoring**: When an analyst opens a Quiver deliverable in Excel or Word Desktop, Microsoft 365 co-authoring, cloud revision tracking, and auto-save work natively.
4. **Lineage appendix (honest scope)**: Quiver writes inspection-ready lineage into an evidence companion and, where implemented, an endnote-style appendix. Inline Word `w:comment` balloons and Excel cell notes are not the current default writer — do not market them as shipped until they are.

---

### Implementation Status Matrix: M365 Storage

| Component / Feature | Rationale & Design | Implementation Status | Location in Codebase |
| :--- | :--- | :--- | :--- |
| **Native OpenXML Generation** | Builds standard `.docx`, `.xlsx`, `.pptx` matching house templates. | **SHIPPED** | `src/tools/office_doc.ts`, OfficeCLI binary |
| **OpenXML Lineage Comments** | Evidence companion + appendix lineage shipped; inline Word comments / Excel cell notes not implemented as the default writer | **FOUNDATION** | `src/document/word_lineage.ts`, `src/evidence/tracker.ts` |
| **Evidence Companion Hard Gate** | Refuses invalid quantitative lineage and blocks final review sign-off without a valid companion evidence file. | **SHIPPED** | `src/evidence/validator.ts`, `src/evidence/tracker.ts`, `ui/main.ts` |
| **Local Sync Path Support** | Writes deliverables through the normal local filesystem path; Windows sync locks receive bounded retry handling and existing create/merge targets require explicit overwrite intent. | **SHIPPED (bounded)** | `src/tools/office_doc.ts`, `src/security/path_policy.ts` |
| **SharePoint Graph Exporter** | Direct upload for small files and Graph upload sessions for larger files. Access-token authentication remains engagement-managed; OAuth refresh is not included. | **SHIPPED (integration shape)** | `src/export/dms.ts`, `SharePointExporter` class |
| **NetDocuments Exporter** | Uploads deliverables to NetDocuments REST API. | **SHIPPED (Framework)** | `src/export/dms.ts`, `NetDocumentsExporter` class |
| **Purview Native SDK Labeling** | Programmatic byte-level Microsoft Purview sensitivity labeling before cloud upload. | **PLANNED** | Inherited via M365 cloud policy; native pre-upload byte labeling is engagement-specific. |

---

## Summary & Strategic Guidance for Engagement Teams

1. **For PKM**: Deploy Quiver's dual-storage plain text memory. Use the Context Consent Gate (`/consent`) and Context HUD to provide total transparency into memory injection. Never introduce third-party vector databases that obscure what context the model sees.
2. **For Microsoft 365 Integration**: Use OfficeCLI locally or within synced SharePoint folders. On Windows, install OfficeCLI using its official Windows distribution or set `QUIVER_OFFICECLI_PATH`; Quiver retries transient sync-client locks. For cloud-only environments, configure `SHAREPOINT_GRAPH_ENDPOINT`, `SHAREPOINT_SITE_ID`, `SHAREPOINT_DRIVE_ID`, and an engagement-managed `SHAREPOINT_ACCESS_TOKEN` (plus the active adapter in `.quiver/dms.json`) to enable direct exports. Token refresh and tenant consent remain engagement-specific.
