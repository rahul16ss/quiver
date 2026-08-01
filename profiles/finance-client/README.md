# Deployment Profile: `finance-client`

The `finance-client` profile provides a hardened operational boundary for institutional investment, advisory, and wealth management clients.

---

## 1. Enabled Capabilities

When running under the `finance-client` profile, the following workflow tools are enabled:

- **Approved File Access**: Read and inspect files within explicit project data boundaries.
- **Native Office Generation**: Drive OfficeCLI for `.docx`, `.xlsx`, and `.pptx` creation.
- **Evidence Lineage**: Track sources, quantitative figures, and cell read-back lineage.
- **Human Review Gates**: Force review of open flags and require signer mark-final sign-off.
- **Approved Retrieval Connectors**: Scoped data retrieval from configured internal or vendor endpoints.
- **Tamper-Evident Run Logs**: Local audit log of all model calls, context loads, and review actions.

---

## 2. Disabled Capabilities (Security & Boundary Controls)

The following capabilities are **disabled by default** to minimize attack surface:

- ✕ Arbitrary shell command execution (`run_command` disabled)
- ✕ Unapproved external tool servers / MCP tools
- ✕ Dynamic tool creation at runtime
- ✕ Automatic background cloud folder synchronization
- ✕ Unapproved public web scraping outside declared sources
- ✕ Parallel subagent spawning without approval gate

---

## 3. Client Onboarding & Deployment Note

Client teams are **not** expected to self-install or configure developer tools during discovery. Environment setup, profile configuration, acceptance testing, and handover documentation are fully scoped as part of the Conviction Studio workflow sprint engagement.
