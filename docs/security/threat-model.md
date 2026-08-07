# Quiver Threat Model

## Overview

This document defines the formal threat model for Quiver, the open agent harness behind controlled, source-backed document workflows in finance. Security, user data ownership, explicit consent, and inspectable state are non-negotiable requirements. Data handling and model use are configured around the workflow's sensitivity — the model endpoint is user-configured (no baked default), so the model boundary in this document is treated as remote unless a local endpoint is configured.

## Threat Agents

1. **Malicious repository files** — Untrusted code, configs, or documentation in the user's workspace that contain prompt injection attacks.
2. **Compromised model outputs** — Model responses that attempt to execute dangerous commands or exfiltrate data.
3. **Compromised dependencies** — Malicious or vulnerable packages in the dependency tree (supply chain).
4. **Network attackers** — Man-in-the-middle attacks on model API connections (remote by default; local when configured).

## Threat Catalog

### T1: Prompt Injection from Untrusted Repository Files

- **Description:** A file in the user's workspace contains text designed to override the system prompt or safety rules (e.g., "ignore previous instructions").
- **Mitigation:** All file contents are wrapped in `<untrusted_file>` tags via `src/prompts/security.ts`. The system prompt includes `SECURITY_PREAMBLE` instructing the model to treat untrusted content as data, not instructions. Tool calls are parsed programmatically, never executed from raw model text.
- **Residual Risk:** Model may still be influenced by well-crafted injections. Defense-in-depth via approval gates and path sandboxing.

### T2: Malicious or Sandboxed Tool Outputs

- **Description:** A tool returns output containing instructions or code designed to manipulate the agent.
- **Mitigation:** Tool outputs are treated as untrusted content. Large outputs are offloaded to files (`src/context_manager.ts`). The agent must use `view_file` to read them, which wraps content in untrusted boundaries.

### T3: Runtime Tool Synthesis

- **Status:** Not in product. Registry loads static shipped tools from `src/tools/` only.

### T4: Shell Command Injection

- **Description:** The agent executes a shell command that destroys data, exfiltrates secrets, or modifies system files.
- **Mitigation:** Shell commands are classified by risk band via `src/security/command_policy.ts`. Destructive, privileged, network, and exfiltration-risk commands always require manual user confirmation. Commands targeting paths outside the workspace are denied. Approvals are tied to command hash and working directory.

### T5: Path Traversal and Symlink Escapes

- **Description:** The agent attempts to read or write files outside the workspace via relative paths, `..` traversal, or symlinks.
- **Mitigation:** `src/security/path_policy.ts` canonicalizes paths, resolves symlinks via `realpathSync`, and verifies the target resolves inside the workspace root. Global blocked paths (`.env`, `.git/`, `~/.ssh/`, etc.) are never accessible.

### T6: Secret and Credential Exfiltration

- **Description:** Secrets in files, environment variables, or tool outputs are sent to remote model providers or written to logs.
- **Mitigation:** `src/security/secrets.ts` detects common secret formats (AWS keys, SSH keys, API keys, Bearer tokens) and redacts them before logging, syncing, or sending to remote providers. The user is warned before sending suspected secrets to remote providers. Secret-labeled memories are never sent to remote models.

### T7: Arbitrary Code Execution via the Loopback Daemon

- **Description:** A vulnerability in the browser UI or a request that escapes the loopback binding allows arbitrary code execution through the daemon.
- **Mitigation:** The daemon binds to loopback ONLY (127.0.0.1, never 0.0.0.0), enforces strict Host/origin validation, requires a per-install secret on every state-changing/API request (timing-safe compare), sets CSP + X-Frame-Options: DENY + nosniff headers, and the browser UI never exposes Node APIs. There is no Electron main process; the renderer is a plain browser page with no privileged IPC.

### T8: Cloud Sync Leakage — **REMOVED**

- **Description (historical):** Private memory files or secrets could be synced to a cloud folder without encryption.
- **Status:** Automatic background cloud-folder sync was removed entirely (not merely disabled). Use local synced M365 folders or the engagement DMS export path instead.

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
│  │  Trust Tiers + Read Scope + Allow-Globs (US-6.4)     │ │
│  │  observe→yolo ladder; per-project; scoped approvals  │ │
│  └─────────────────────────────────────────────────────┘ │
│         │                                               │
│  ┌──────┴────────────────┴────────────────────┴────────┐ │
│  │  Ambient Verification (always on)                    │ │
│  │  Maker-checker (per-change) + Self-heal/Goal-loop    │ │
│  │  (completion) — one runChecker primitive, no dup     │ │
│  └─────────────────────────────────────────────────────┘ │
│         │                                               │
│  ┌──────┴────────────────┴────────────────────┴────────┐ │
│  │           Tool Sandbox (Untrusted)                  │ │
│  │  Worker threads for isolated tool execution        │ │
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
- **Trust tiers & granular permissions (US-6.4)** — `applyTrustTier()` sets a
  cumulative `observe`→`yolo` ladder (grants + read scope + sandbox policy),
  persisted per-project. Allow-globs are enforced (not decorative). A scoped
  approval cache lets the user approve "all similar this session" without a
  global grant.
- **Ambient verification (US-13.5)** — self-heal + goal-loop are always-on
  harness behaviors driven by the _single_ `runChecker` primitive (no parallel
  `tsc`/`npm test`): per-change targeted checks (maker-checker, unconditional)
  plus one full completion check that auto-heals on `revise`/`reject`.
- **Mid-run intervention (US-2.3)** — `Esc` injects a steering message at the
  next loop boundary; `Ctrl+C` aborts the stream. The user can redirect the
  agent while it is running, so a hijacked/hallucinating loop can be steered
  before it does damage (defense-in-depth on T2/T4).
- **Ambient log retention (US-13.3)** — old session logs auto-purge at startup
  so sensitive accumulated state does not persist indefinitely (T10).

The acceptance contract (`tests/spec_acceptance_tests.ts`, `npm test`) verifies each of these
enforcements behaviorally and via its `WIRE-*` integration checks.

## Incident Response

1. **Prompt injection detected:** The agent's output is logged, the untrusted content is flagged, and the user is notified.
2. **Dangerous command blocked:** The command is logged with its risk classification, and the user is prompted for approval.
3. **Secret detected in output:** The secret is redacted, and the user is warned before any remote transmission.
4. **Path traversal blocked:** The attempted path is logged, and the operation is denied.
5. **Tool sandbox violation:** The worker is terminated, and the tool is disabled pending user review.
