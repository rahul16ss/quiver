# Attributions

Quiver is built on the shoulders of giants. The following open-source projects
are leveraged, customized, and tightly integrated into the Quiver product.

## AionUi

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

## OfficeCLI

- **Project:** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
- **Authors:** iOfficeAI, 9 contributors
- **License:** Apache 2.0
- **Usage:** OfficeCLI is bundled with Quiver to provide Word (.docx),
  Excel (.xlsx), and PowerPoint (.pptx) document creation and editing
  capabilities. This enables Quiver's non-technical knowledge worker ICP
  (analysts, researchers, consultants, legal professionals) to generate
  professional Office documents through natural language.
- **What we kept:** The single-binary CLI tool, SKILL.md agent instruction
  file, and all document creation/editing commands.
- **What we customized:** Bundled as a Quiver-native tool (not MCP),
  integrated into Quiver's tool registry as `office_doc` tool, skills
  customized for Quiver's knowledge-work use cases (investment briefs,
  research reports, compliance reviews).

## Other Open-Source Dependencies

- **Electron** — MIT License — Desktop application framework
- **React** — MIT License — UI rendering (via AionUi architecture)
- **TypeScript** — Apache 2.0 — Language
- **tsx** — MIT License — TypeScript execution
- **Zod** — MIT License — Schema validation
- **dotenv** — BSD-2-Clause — Environment variable loading
- **picocolors** — ISC — Terminal colors
- **puppeteer** — Apache 2.0 — Browser automation
- **sharp** — Apache 2.0 — Image processing

## License

Quiver is licensed under Apache 2.0, consistent with all leveraged projects.