# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Quiver, please report it responsibly:

1. **Do not open a public GitHub issue.**
2. Email **hello@convictionstudio.com** with a description of the vulnerability, steps to reproduce, and potential impact.
3. We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Threat model

Quiver is an agent harness for financial document workflows. The model boundary is the primary trust boundary — prompt content is sent to whatever endpoint the user configures via `LLM_API_BASE_URL`. Treat the model as remote unless a local endpoint is explicitly configured.

Key security properties:

- **Path sandbox**: file tools enforce workspace-boundary checks; GUI-spawned agents cannot write into Quiver's own source tree (`QUIVER_PROTECTED_DIR`).
- **Maker-checker**: the agent cannot self-certify its work; an isolated checker runs the acceptance contract on a copy-on-write scratchpad with no network access and no secrets.
- **Secret handling**: API keys live in the OS keychain (preferred) or a 0600 `.env` (fallback). Secrets are redacted from logs, diagnostics, and session history. The checker child process receives no secrets.
- **Audit chain**: all tool calls, approvals, and checker verdicts are appended to a tamper-evident hash-chained audit log.
- **Sensitivity routing**: high-sensitivity input is routed to a local model endpoint or refused (never sent to a cloud provider). MNPI redaction is enforced at the model call for the mid tier.

See [docs/security/threat-model.md](docs/security/threat-model.md) for the full threat model and [docs/security/soc2-mapping.md](docs/security/soc2-mapping.md) for the SOC2 TSC mapping.
