# Attributions

Quiver is built on the shoulders of giants. This file credits the open-source
projects that are **leveraged and integrated** into the product, and the
pioneer frameworks whose **architecture and design paradigms** inspired
Quiver's design.

---

## Leveraged & Integrated Projects

Quiver's codebase directly uses, customizes, and tightly integrates the
following projects.

### AionUi

- **Project:** [AionUi](https://github.com/iofficeai/aionui)
- **Authors:** iOfficeAI, 90+ contributors
- **License:** Apache 2.0
- **Usage:** The Quiver desktop GUI is derived from the AionUi Electron
  architecture. We forked the renderer, preload, and main process patterns,
  then customized them for tight coupling with the Quiver CLI. AionUi's
  chat interface, workspace file panel, preview system, and settings
  architecture provided the foundation for Quiver's desktop experience.
- **What we kept:** Electron + React renderer architecture, IPC bridge
  pattern, conversation/workspace layout, preview panel concept, settings
  modal structure.
- **What we customized:** Removed multi-agent/multi-CLI support (Quiver is
  tightly coupled to its own CLI only), replaced AionUi's agent detection
  with direct Quiver CLI spawning, added Quiver's unique context transparency
  panel, AI explainability features (maker-checker verdicts, audit chain
  timeline, reasoning visibility), and plain-text memory editing.

### OfficeCLI

- **Project:** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
- **Authors:** iOfficeAI, 9 contributors
- **License:** Apache 2.0
- **Usage:** OfficeCLI is bundled with Quiver to provide Word (.docx),
  Excel (.xlsx), and PowerPoint (.pptx) document creation and editing
  capabilities. This enables Quiver's business-user ICP
  (analysts, researchers, consultants, legal professionals) to generate
  professional Office documents through natural language.
- **What we kept:** The single-binary CLI tool (`officecli`); core document
  operations (create, add, set, get, view, validate, batch, remove, move,
  swap); the schema-driven help system; the SKILL.md agent instruction file.
- **What we stripped (not loaded, not bundled):** MCP server mode (Quiver has
  its own MCP client; OfficeCLI is a native tool), the plugins system
  (Quiver's tool registry is the extension point), the skills installer for
  other agents, and watch mode (replaced by Quiver's GUI preview panel).
- **What we customized:** Bundled as a Quiver-native tool (`office_doc` in
  the tool registry); uses `execFile` (not `exec`) for safe argument passing;
  skills customized for Quiver's business use cases (investment-brief,
  competitive-matrix, due-diligence, legal-research, regulatory-summary);
  binary discovery via the shared `findBinary()` utility.

### Other Direct Dependencies

- **Electron** — MIT License — Desktop application framework
- **React** — MIT License — UI rendering (via AionUi architecture)
- **TypeScript** — Apache 2.0 — Language
- **tsx** — MIT License — TypeScript execution
- **Zod** — MIT License — Schema validation
- **dotenv** — BSD-2-Clause — Environment variable loading
- **picocolors** — ISC — Terminal colors
- **puppeteer** — Apache 2.0 — Browser automation
- **sharp** — Apache 2.0 — Image processing

---

## Architectural Influences

Quiver's codebase is built from scratch in TypeScript, but its architecture and
design paradigms are inspired by several pioneer agentic frameworks. We
gratefully acknowledge their influences below.

### LangChain (langchain-ai)

- **Influence:** Harness architecture and visualization concept diagrams.
- **Contribution:** LangChain's pipeline orchestration structure and
  technical explainability diagram systems inspired the design of Quiver's
  Open Harness Loop and Request Interception pipeline.
- **Project:** [https://github.com/langchain-ai/langchain](https://github.com/langchain-ai/langchain)
- **License:** MIT License

### Goose (aaif-goose)

- **Influence:** Model Context Protocol (MCP) extensions & tool-calling design.
- **Contribution:** Goose's model-agnostic harness, dynamic tool loading, and
  focus on Model Context Protocol inspired Quiver's dynamic ESM tools
  registry, terminal icon styling, and MCP client extensions.
- **Project:** [https://github.com/aaif-goose/goose](https://github.com/aaif-goose/goose)
- **License:** Apache License 2.0

### Letta (memgpt)

- **Influence:** Stateful memory & context serialization.
- **Contribution:** Letta's structured memory blocks (Persona/System identity,
  Human context, and Project context) inspired Quiver's memory layout
  (`memory/core.json`). The serialization concept for porting agent sessions
  is adapted from Letta's state management protocols.
- **Project:** [https://github.com/letta-ai/letta](https://github.com/letta-ai/letta)
- **License:** Apache License 2.0

### Stanford STORM (oval-storm)

- **Influence:** Pre-compilation outline generation.
- **Contribution:** STORM's concept of synthesizing detailed outlines and
  querying sources from multiple perspectives before drafting guides inspired
  Quiver's market research decomposition strategy (e.g. generating sub-tasks
  dynamically before compiling reports).
- **Project:** [https://github.com/stanford-oval/storm](https://github.com/stanford-oval/storm)
- **License:** MIT License

### Beads

- **Influence:** Git-integrated task version control.
- **Contribution:** Beads' approach of storing state lists in git-versioned
  structures inspired Quiver's goal-seeking harness layout (`goals.json`),
  ensuring task histories are tracked cleanly and auditable in Git.
- **Project:** [https://github.com/gastownhall/beads](https://github.com/gastownhall/beads)
- **License:** MIT License

### Dexter

- **Influence:** Planning → Execution → Verification → Self-Correction.
- **Contribution:** Dexter's validation assertion loops inspired Quiver's
  goal-loop verification checks (e.g. running unit tests or file existence
  assertions in `goals.json` and resetting status to `"failed"` on errors to
  trigger self-correction).
- **Project:** [https://github.com/virattt/dexter](https://github.com/virattt/dexter)
- **License:** MIT License

---

## License

Quiver is licensed under Apache 2.0, consistent with all leveraged projects.
