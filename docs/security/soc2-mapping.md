# Quiver SOC2 Trust Services Criteria Mapping

## Overview

This document maps Quiver's architectural subsystems to the AICPA Trust Services Criteria (TSC).
It demonstrates how Quiver's local-first, security-first design supports SOC2 compliance for
enterprise deployments.

## Trust Services Criteria Mapping

### CC1 — Control Environment

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC1.1 | `src/agent.ts` | Agent operates under explicit user consent. No action taken without approval for high-risk operations. |
| CC1.2 | `src/config.ts`, `src/config/schema.ts` | Versioned configuration schema with validation. All settings are inspectable and user-controlled. |
| CC1.3 | `src/lifecycle.ts` | Lifecycle hooks provide structured interception points. All hooks follow fail-closed security semantics. |

### CC2 — Communication and Information

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC2.1 | `src/cli_ui.ts`, `src/agent.ts` | Context manifest displayed before every model call. User sees exactly what enters the prompt. |
| CC2.2 | `src/session_logger.ts`, `src/logger.ts` | All actions logged with timestamps, redacted secrets, and audit chain hashes. |
| CC2.3 | `docs/security/threat-model.md` | Formal threat model documents all security boundaries and incident response procedures. |

### CC3 — Risk Assessment

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC3.1 | `src/security/command_policy.ts` | Shell commands classified into risk bands: safe, moderate, network, destructive, privileged, secret-risk, exfiltration-risk. |
| CC3.2 | `src/security/path_policy.ts` | Path sandboxing prevents access outside workspace. Blocked paths enforced globally. |
| CC3.3 | `src/security/secrets.ts` | Secret detection scans all outputs before logging or transmission. |
| CC3.4 | `docs/security/threat-model.md` | Threat model covers 10 threat categories with mitigations and residual risk assessments. |

### CC4 — Monitoring Activities

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC4.1 | `src/logger.ts`, `src/session/checkpoint.ts` | Tamper-proof SHA-256 audit chain. H_n = SHA-256(H_{n-1} + action_payload). Any alteration breaks the chain. |
| CC4.2 | `src/session/checkpoint.ts` | Crash detection on launch. Incomplete sessions flagged for user review. |
| CC4.3 | `src/diagnostics.ts` | Consecutive failure tracking. 3 identical failures trigger pause and user alert. |

### CC5 — Control Activities

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC5.1 | `src/security/command_policy.ts` | AST-based shell command risk classification. Destructive/privileged commands always require manual approval. |
| CC5.2 | `src/session/file_access.ts` | Hash-based read-before-write (compare-and-swap). SHA-256 + mtimeMs + size verification before any file mutation. |
| CC5.3 | `src/fs/atomic_write.ts` | Atomic writes (temp-write-then-rename). Backup created before overwrite. `/rollback last` restores previous state. |
| CC5.4 | `src/diff.ts` | Diff preview before risky edits. Package files, lockfiles, CI configs, and database migrations require explicit approval. |
| CC5.5 | `src/agent.ts` | Idempotent retries with jitter. Only retry-safe tools (search, read) auto-retry. State-changing commands never retried. |

### CC6 — Logical and Physical Access Controls

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC6.1 | `src/security/path_policy.ts` | Workspace path sandbox. Canonicalizes paths, resolves symlinks, verifies target inside workspace root. |
| CC6.2 | `src/secrets/keychain.ts` | OS credential store integration (macOS Keychain, Windows Credential Manager, Linux Secret Service). API keys never stored in plain text. |
| CC6.3 | `src/secrets/env_fallback.ts` | `.env` fallback with restrictive permissions (0600). Auto-added to `.gitignore`. Excluded from sync and model context. |
| CC6.4 | `ui/ipc_contract.ts`, `ui/security.ts` | Electron IPC isolation. Strict channel allowlist, payload schema validation, contextIsolation, no nodeIntegration. |
| CC6.5 | `src/tools/sandbox.ts` | Tool sandbox execution. Out-of-process worker threads with least-privilege constraints. |

### CC7 — System Operations

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC7.1 | `src/session/checkpoint.ts` | Checkpoints written after every turn and action. Crash recovery on launch detects incomplete sessions. |
| CC7.2 | `src/session_logger.ts` | Log retention: `/logs list`, `/logs purge --older-than 30d`, `/logs export`. Secrets auto-redacted. |
| CC7.3 | `src/diagnostics.ts` | Self-diagnostics: structured diagnostic blocks with tool name, args, error, stderr, callstack, suggested remedies. |
| CC7.4 | `src/agent.ts` | Stream stall protection. Connection, stream-stall, and tool timeouts configured per-adapter/model. |

### CC8 — Change Management

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC8.1 | `src/config/schema.ts` | Versioned config schema (v1). Migration support for older configs. Schema validation on load. |
| CC8.2 | `src/fs/atomic_write.ts` | Atomic writes with rollback. Backup created before overwrite. `/rollback last` command. |
| CC8.3 | `src/session/schema.ts` | Versioned session schema (v1). Sessions can be resumed after upgrades. |
| CC8.4 | `src/tools/runtime.ts` | Tool approval workflow. Generated tools disabled by default. User must inspect source code and permissions before activation. |

### CC9 — Risk Mitigation

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| CC9.1 | `src/cloud_sync.ts` | Cloud sync disabled by default. User must explicitly opt in. Secrets, `.env`, credentials excluded. |
| CC9.2 | `src/sync/conflicts.ts` | Sync conflict resolution. Both versions preserved on conflict. User prompted for resolution. |
| CC9.3 | `src/memory/privacy.ts` | Memory privacy labels: public, project, private, secret. Secret-labeled memories never sent to remote models or synced. |
| CC9.4 | `src/memory/review_queue.ts` | Memory review queue. Extracted facts enter pending state. User must accept, edit, or reject before activation. |

## Additional Criteria

### Availability (A)

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| A1.1 | `src/session/checkpoint.ts` | Checkpoint-based crash recovery. Work preserved across crashes. |
| A1.2 | `src/context_manager.ts` | Context compaction at 85% threshold prevents OOM and context overflow failures. |
| A1.3 | `src/agent.ts` | Tool retry with exponential backoff and jitter handles transient failures. |

### Confidentiality (C)

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| C1.1 | `src/security/secrets.ts` | Secret detection and redaction before logging, syncing, or remote transmission. |
| C1.2 | `src/memory/privacy.ts` | Privacy labels control what memory is sent to remote models. Secret-labeled data never leaves the machine. |
| C1.3 | `src/cloud_sync.ts` | Client-side AES-256-GCM encryption for sync. Passphrase stored in OS credential store. |

### Processing Integrity (PI)

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| PI1.1 | `src/session/file_access.ts` | Hash-based read-before-write ensures files are not blindly overwritten. Compare-and-swap mechanism. |
| PI1.2 | `src/logger.ts` | Tamper-proof audit chain. SHA-256 hash chain makes audit records tamper-evident. |
| PI1.3 | `src/diagnostics.ts` | Diagnostic blocks ensure errors are surfaced to the model for self-repair, not silently swallowed. |

### Privacy (P)

| Criteria | Quiver Subsystem | Implementation |
|----------|-----------------|----------------|
| P1.1 | `src/cloud_sync.ts` | Sync is opt-in only. No data leaves the machine without explicit user consent. |
| P1.2 | `src/config.ts` | Remote model use requires disclosure that project context may leave the machine. |
| P1.3 | `src/memory/review_queue.ts` | Extracted memories enter pending state. User controls what becomes permanent context. |
| P1.4 | `src/session_logger.ts` | Log retention commands allow users to manage and purge accumulated data. |

## CI Dependency Security

Per US-9.5, the CI pipeline must:
1. Run `npm audit` on every pull request
2. Run static secret detection scans (using `src/security/secrets.ts` patterns)
3. Run the full test suite (`tests/run_tests.ts`)
4. Verify TypeScript compilation (`tsc --noEmit`)
5. Verify audit chain integrity in tests

## Verification

The audit chain can be verified at any time:

```bash
quiver /audit verify
```

This reads the session's audit log and recomputes every hash, flagging any tampering.