# Quiver Threat Model

## Overview

This document defines the formal threat model for Quiver, a local-first AI coding and research harness. Security, local-first behavior, user data ownership, explicit consent, and inspectable state are non-negotiable requirements.

## Threat Agents

1. **Malicious repository files** — Untrusted code, configs, or documentation in the user's workspace that contain prompt injection attacks.
2. **Compromised model outputs** — Model responses that attempt to execute dangerous commands or exfiltrate data.
3. **Rogue tool scripts** — Dynamically generated tools (`create_tool`) that contain malicious code.
4. **Network attackers** — Man-in-the-middle attacks on local model API connections.
5. **Supply chain attacks** — Compromised dependencies in the Quiver dependency tree.

## Threat Catalog

### T1: Prompt Injection from Untrusted Repository Files
- **Description:** A file in the user's workspace contains text designed to override the system prompt or safety rules (e.g., "ignore previous instructions").
- **Mitigation:** All file contents are wrapped in `<untrusted_file>` tags via `src/prompts/security.ts`. The system prompt includes `SECURITY_PREAMBLE` instructing the model to treat untrusted content as data, not instructions. Tool calls are parsed programmatically, never executed from raw model text.
- **Residual Risk:** Model may still be influenced by well-crafted injections. Defense-in-depth via approval gates and path sandboxing.

### T2: Malicious or Sandboxed Tool Outputs
- **Description:** A tool returns output containing instructions or code designed to manipulate the agent.
- **Mitigation:** Tool outputs are treated as untrusted content. Large outputs are offloaded to files (`src/context_manager.ts`). The agent must use `view_file` to read them, which wraps content in untrusted boundaries.

### T3: Dangerous Runtime Tool-Synthesis Scripts (`create_tool`)
- **Description:** The agent generates a tool with malicious code that executes arbitrary commands or accesses secrets.
- **Mitigation:** Generated tools are written to project-local data folders, never to application source. User must inspect and approve tool source code before activation. Tools execute in isolated sandbox workers (`src/tools/sandbox.ts`) with least-privilege constraints. Tool manifests specify permissions (filesystem read/write globs, network access, shell access, env keys).

### T4: Shell Command Injection
- **Description:** The agent executes a shell command that destroys data, exfiltrates secrets, or modifies system files.
- **Mitigation:** Shell commands are classified by risk band via `src/security/command_policy.ts`. Destructive, privileged, network, and exfiltration-risk commands always require manual user confirmation. Commands targeting paths outside the workspace are denied. Approvals are tied to command hash and working directory.

### T5: Path Traversal and Symlink Escapes
- **Description:** The agent attempts to read or write files outside the workspace via relative paths, `..` traversal, or symlinks.
- **Mitigation:** `src/security/path_policy.ts` canonicalizes paths, resolves symlinks via `realpathSync`, and verifies the target resolves inside the workspace root. Global blocked paths (`.env`, `.git/`, `~/.ssh/`, etc.) are never accessible.

### T6: Secret and Credential Exfiltration
- **Description:** Secrets in files, environment variables, or tool outputs are sent to remote model providers or written to logs.
- **Mitigation:** `src/security/secrets.ts` detects common secret formats (AWS keys, SSH keys, API keys, Bearer tokens) and redacts them before logging, syncing, or sending to remote providers. The user is warned before sending suspected secrets to remote providers. Secret-labeled memories are never sent to remote models.

### T7: Arbitrary Code Execution in Electron Main Process
- **Description:** A vulnerability in the Electron renderer allows arbitrary code execution in the main process.
- **Mitigation:** Electron hardening: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP, allowlisted IPC channels with schema validation. Renderer cannot directly access filesystem or environment. All IPC payloads are validated.

### T8: Cloud Sync Leakage
- **Description:** Private memory files or secrets are synced to a cloud folder without encryption.
- **Mitigation:** Sync is disabled by default. Client-side AES-256-GCM encryption before writing to shared folders. Secrets, `.env`, credential files, and raw private logs are excluded from sync by default. Writes are atomic (temp-write-then-rename).

### T9: Memory Poisoning
- **Description:** Malicious or incorrect facts are inserted into memory without user review.
- **Mitigation:** Extracted facts enter a 'pending' state in the memory review queue (`src/memory/review_queue.ts`). User must accept, edit, or reject facts before they enter active prompt assembly. Citation tracking and decay functions identify unused or false memories.

### T10: Retention of Sensitive Data in Session Logs
- **Description:** Session logs accumulate secrets or sensitive data over time.
- **Mitigation:** `src/session_logger.ts` and `src/security/secrets.ts` redact secrets before writing to disk. CLI commands `/logs purge --older-than 30d` and `/logs export` manage log retention. Logs are truncated to configurable max chars.

## Security Boundaries

```
┌─────────────────────────────────────────────────────────┐
│                    User (Trusted)                         │
├─────────────────────────────────────────────────────────┤
│              Approval Gate (Interactive)                   │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Path Policy  │  │ Command      │  │ Secret          │  │
│  │ Sandbox      │  │ Risk Class   │  │ Redaction        │  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                │                    │           │
│  ┌──────┴────────────────┴────────────────────┴────────┐ │
│  │              Agent Core (Semi-Trusted)               │ │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────┐   │ │
│  │  │ Read-      │  │ Atomic     │  │ Prompt       │   │ │
│  │  │ Before-    │  │ Writes     │  │ Injection    │   │ │
│  │  │ Write      │  │ + Rollback │  │ Defense      │   │ │
│  │  └────────────┘  └────────────┘  └──────────────┘   │ │
│  └─────────────────────────────────────────────────────┘ │
│         │                │                    │           │
│  ┌──────┴────────────────┴────────────────────┴────────┐ │
│  │           Tool Sandbox (Untrusted)                  │ │
│  │  Worker threads with least-privilege constraints     │ │
│  └─────────────────────────────────────────────────────┘ │
│         │                                               │
│  ┌──────┴──────────────────────────────────────────────┐ │
│  │         Workspace Files (Untrusted)                  │ │
│  │  Wrapped in <untrusted_file> tags                    │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────────────────┐
│              Model Provider (Remote/Local)               │
│  Secrets redacted before transmission                     │
│  Privacy labels filter what memories are sent            │
└─────────────────────────────────────────────────────────┘
```

## Wiring & Enforcement Status

The mitigations above are enforced in the live agent loop and the tools, not
just present as modules:

- **Path sandbox (T5)** — `view_file`, `write_file`, `replace_content`, and
  `apply_patch` resolve every target through `assertToolPathAllowed`
  (`src/security/tool_paths.ts`). Non-existent files under a symlinked
  workspace (e.g. macOS `/var` → `/private/var`) are normalized via the
  deepest existing ancestor so a new file deep in the workspace is never
  wrongly blocked.
- **Command risk classification (T4)** — `run_command` classifies each command
  and refuses outside-workspace targets; the agent approval gate uses the same
  `classifyCommand()` so approval is bound to risk band, not tool name.
- **Read-before-write (T2/T5)** — `FileReadHistory` (SHA-256 + mtimeMs) replaces
  the path-only `Set<string>` tracker, so a file changed between read and write
  is never silently overwritten.
- **Atomic writes** — file-mutating tools use temp-write-then-rename with a
  backup recorded for `/rollback`.
- **Secrets in the OS keychain (T6)** — `src/secrets/keychain.ts` shell-escapes
  `service`/`account` for the macOS `security` command (closes a command-
  injection vector) and retrieves Windows credentials via the Win32 `CredRead`
  PInvoke (`cmdkey /list` deliberately does not expose passwords).
- **Stable project identity (US-1.2)** — `getProjectId()` returns a persisted
  UUID (`~/.quiver/projects/{name}/project.json`) used as the canonical
  `project_id` in checkpoints, so identity survives `process.cwd()` basename
  changes.

The acceptance contract (`tests/spec_acceptance_tests.ts`, `npm test`) verifies each of these
enforcements behaviorally and via its `WIRE-*` integration checks.

## Incident Response

1. **Prompt injection detected:** The agent's output is logged, the untrusted content is flagged, and the user is notified.
2. **Dangerous command blocked:** The command is logged with its risk classification, and the user is prompted for approval.
3. **Secret detected in output:** The secret is redacted, and the user is warned before any remote transmission.
4. **Path traversal blocked:** The attempted path is logged, and the operation is denied.
5. **Tool sandbox violation:** The worker is terminated, and the tool is disabled pending user review.