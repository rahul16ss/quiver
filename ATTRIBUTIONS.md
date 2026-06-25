# Attributions and Influences

Quiver is an open-source model-agnostic agent harness designed for coding and research. While our codebase is built from scratch in TypeScript, the architecture and design paradigms are inspired by several pioneer agentic frameworks. We gratefully acknowledge their influences below:

---

## 1. Goose (aaif-goose)
*   **Influence:** Model Context Protocol (MCP) Extensions & Tool calling design.
*   **Contribution:** Goose's model-agnostic harness, dynamic tool loading, and focus on Model Context Protocol inspired Quiver's dynamic ESM tools registry and planned MCP client extensions.
*   **Project URL:** [https://github.com/aaif-goose/goose](https://github.com/aaif-goose/goose)
*   **License:** Apache License 2.0

---

## 2. Letta (memgpt)
*   **Influence:** Stateful Memory & Context Serialization.
*   **Contribution:** Letta's structured memory blocks (Persona/System identity, Human context, and Project context) inspired Quiver's memory layout (`memory/core.json`). The serialization concept for porting agent sessions is adapted from Letta's state management protocols.
*   **Project URL:** [https://github.com/letta-ai/letta](https://github.com/letta-ai/letta)
*   **License:** Apache License 2.0

---

## 3. Stanford STORM (oval-storm)
*   **Influence:** Pre-compilation Outline Generation.
*   **Contribution:** STORM's concept of synthesizing detailed outlines and querying sources from multiple perspectives before drafting guides inspired Quiver's market research decomposition strategy (e.g. generating sub-tasks dynamically before compiling reports).
*   **Project URL:** [https://github.com/stanford-oval/storm](https://github.com/stanford-oval/storm)
*   **License:** MIT License

---

## 4. Beads
*   **Influence:** Git-integrated Task Version Control.
*   **Contribution:** Beads' approach of storing state lists in git-versioned structures inspired Quiver's goal-seeking harness layout (`goals.json`), ensuring task histories are tracked clean and auditable in Git.
*   **Project URL:** [https://github.com/gastownhall/beads](https://github.com/gastownhall/beads)
*   **License:** MIT License

---

## 5. Dexter
*   **Influence:** Planning -> Execution -> Verification -> Self-Correction.
*   **Contribution:** Dexter's validation assertion loops inspired Quiver's goal loop verification checks (e.g. running unit tests or file existence assertions in `goals.json` and resetting status to `"failed"` on errors to trigger self-correction).
*   **Project URL:** [https://github.com/virattt/dexter](https://github.com/virattt/dexter)
*   **License:** MIT License
