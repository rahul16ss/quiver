# Quiver Architecture

## Overview

Quiver is the open, inspectable agent harness behind controlled, source-backed document workflows in finance. This document describes the engine internals; it is built around five primary architectural systems:

1. **Filesystem Context Manager** (`src/context_manager.ts`, `src/paths.ts`)
2. **Harness-Adapter & Provider Split Engine** (`src/adapters/`, `src/providers/`)
3. **Lifecycle Hooks Interception Engine** (`src/lifecycle.ts`)
4. **Active Timeouts & Guardrails** (`src/agent.ts`)
5. **Dynamic Tool Sandbox Registry** (`src/registry.ts`, `src/tools/sandbox.ts`)

## Directory Structure

```
quiver/
├── src/
│   ├── agent.ts              # Core agent loop, approval gates, tool execution
│   ├── cli.ts                # CLI entry point, slash commands
│   ├── config.ts             # Configuration loading (.env + global config), trust tiers
│   ├── context_manager.ts    # LLM summarization, context offloading, compaction
│   ├── lifecycle.ts          # Lifecycle hooks (beforeAgent, beforeModel, etc.)
│   ├── paths.ts              # Filesystem path resolution (~/.quiver/projects/)
│   ├── registry.ts           # Tool registry, dynamic loading
│   ├── state.ts              # Core memory load/save, agent file export
│   ├── logger.ts             # Re-exports AuditChain; session + provenance logging
│   ├── audit_chain.ts        # Tamper-evident AuditChain (provenance fields covered by the hash)
│   ├── session_logger.ts     # Session logging with secret redaction + consent/review decisions
│   ├── vision_router.ts      # Vision fallback routing for multimodal models
│   ├── intervention.ts       # Mid-run steering (Esc injects a user message)
│   ├── ambient.ts            # Ambient self-heal + goal loop at task completion
│   ├── diagnostics.ts        # Structured diagnostic blocks, failure tracking
│   ├── cloud_sync.ts         # Opt-in cloud-folder sync (legacy/advanced; off by default)
│   ├── updates.ts            # Update checks (Ed25519-signed manifests)
│   ├── watchdog.ts           # Self-health queue (findings/summary/status)
│   ├── init.ts               # Project init / onboarding
│   ├── (tool selection)      # model-driven (tool_choice: auto); no separate selector
│   ├── adapters/             # Harness adapter contract (Model-Harness-Fit)
│   ├── providers/            # Model provider abstraction (transport layer)
│   ├── security/             # Path policy, command classification, secrets, seatbelt, scratch-area, sensitivity, consent gate
│   ├── secrets/              # OS keychain integration + .env fallback
│   ├── prompts/              # Security preamble, untrusted content wrapping
│   ├── session/              # File access tracking, schema, checkpoints
│   ├── memory/               # Schema, review queue, privacy, citations, decay, versioned snapshots/diff/rollback
│   ├── evidence/             # Live lineage: SourceRecord/ClaimRecord/EvidenceModel types + session-scoped EvidenceTracker
│   ├── connectors/           # Data-vendor plugin framework (DataConnector interface, caching+TTLs, auto-load from .quiver/connectors/)
│   ├── document/             # Render→Look→Fix orchestrator (officecli screenshot/validate/issues, 5-round cap)
│   ├── context/              # Token budgeting
│   ├── prompt/               # Deterministic prompt assembly
│   ├── fs/                   # Atomic writes with rollback
│   ├── mcp/                  # MCP client + server config (.quiver/mcp.json)
│   ├── subagents/            # Maker-checker (validates Evidence.json, rejects unsourced), targeted check filter, scratchpad helpers
│   └── tools/                # Tool implementations incl. office_doc, evidence, data_query, github, web research, memory (versioned) + sandbox
├── ui/                       # Electron GUI (main, preload, renderer)
├── docs/                     # Documentation, landing page, threat model
├── examples/                 # Flagship example: investment-committee-memo
├── skills/                   # Skill files (investment-brief, due-diligence, …)
├── tests/                    # Checker-owned acceptance contract (spec_acceptance_tests.ts)
└── Formula/                  # Homebrew formula
```

## Data Flow

```
User Input
  → Context Manager (load memory, skills, project context)
  → Tool Definitions (sent to the model; the model selects via tool_choice: auto)
  → Prompt Assembler (deterministic 9-section assembly)
  → Token Budget (check 85% threshold, block if exceeded)
  → Lifecycle Hooks (beforeModel)
  → Model Provider (stream chat completion)
  → Parse Response (text + tool calls)
  → Approval Gate (if high-risk tool)
  → Path Policy + Read-Before-Write (if file operation)
  → Tool Execution (with retry, lifecycle hooks)
  → Result Preview (truncated display)
  → Context Compaction (if needed)
  → Session Checkpoint
  → Lifecycle Hooks (afterAgent)
  → Ambient Verify (at completion, if the turn mutated files — US-13.5)
```

> **Mid-run:** while the loop is running, `Esc` injects a steering user message
> at the next iteration (US-2.3); `Ctrl+C` aborts the active stream.

> **Implementation status.** Every stage above is the *live* agent loop in
> `src/agent.ts`, not aspirational. The model call goes through
> `getActiveProvider().streamChat()`; the prompt through `assemblePrompt()`;
> the budget through `calculateBudget()`/`shouldBlockSubmission()`; file tools
> through the path sandbox (`src/security/tool_paths.ts`) + atomic writes
> (`src/fs/atomic_write.ts`); read-before-write through `FileReadHistory`
> (SHA-256 + mtimeMs compare-and-swap); tool calls through `wrapToolCall()`
> (lifecycle `wrap_tool_call` hooks); and every turn writes a checkpoint via
> `CheckpointManager` for crash recovery. The maker-checker gate is
> **always-on and unconditional** for high-risk operations (US-15.1 forbids an
> env opt-out); at task completion the AmbientEngine runs the same `runChecker`
> once in full mode and auto-heals on `revise`/`reject` (US-13.5). The internal
> trust-tier ladder (`observe`→`propose`→`build`→`operate`, plus an
> unrestricted top tier whose internal alias is `yolo`) shapes read scope +
> sandbox + approval grants (US-6.4); it is developer-only and documented in
> `docs/advanced.md` — business surfaces expose the tiers as **Draft only /
> Draft and research / Assisted**.
> The acceptance contract
> (`tests/spec_acceptance_tests.ts`, `npm test`) verifies this wiring end-to-end
> via its `WIRE-*` integration checks.

## Security Layers

1. **Path Sandbox** — All file operations constrained to workspace root
2. **Command Classification** — Shell commands classified by risk band
3. **Secret Redaction** — Secrets detected and redacted before logging/transmission
4. **Read-Before-Write** — SHA-256 hash verification prevents stale overwrites
5. **Prompt Injection Defense** — Untrusted content wrapped in XML boundaries
6. **Tool Sandbox** — Dynamic tools execute in isolated worker threads; the manifest's `fs` read/write globs are enforced via a permission-checking proxy (US-6.4)
7. **Atomic Writes** — Temp-write-then-rename with backup and rollback
8. **Trust Tiers** — Cumulative `observe`→`propose`→`build`→`operate`→top-tier permission ladder (developer-only; see `docs/advanced.md`) with tier-driven read scope, enforced allow-globs, and per-project persistence (US-6.4). Business surfaces name the tiers **Draft only / Draft and research / Assisted**.
9. **Ambient Verification** — Self-heal + goal-loop driven by the single maker-checker primitive (US-13.5)
10. **Mid-run Intervention** — `Esc` steers the agent while it runs (US-2.3)

## Maker-Checker Verification (Epic 15)

Every unit of work is treated as a transaction that is *made* and then
*independently checked* before it touches the user's workspace, generalizing
the safety primitives (subagent pool, JIT sandbox, path sandbox, audit chain,
diff approval) into one automatic verification discipline.

- **Maker** — the primary agent loop (or a maker subagent) produces the proposed
  change: file edits, shell commands, tool calls, or generated tools.
- **Checker** — `src/subagents/checker.ts` is a structurally isolated second
  instance that verifies the maker's output *before* it is applied. It runs in
  its own sandboxed context with **read-only** workspace access and **no**
  write, network, secret, or full-`process.env` access. Its only output is a
  structured verdict — `approve | reject | revise` — with evidence.
- **Separation of concern** — maker and checker never share mutable state. The
  checker receives the user's intent, the governing acceptance criteria, the
  proposed diff/tool-call, and a copy-on-write scratchpad on which it may run
  tests; it cannot alter the real project. The change merges only after the
  checker's `approve`.
- **Spec-aware** — the checker runs the relevant acceptance checks (including
  `tests/spec_acceptance_tests.ts`) against the scratchpad, so verification is
  grounded in the blueprint rather than the maker's self-assessment.
- **Inspectable** — every verdict, its evidence, and any user override are
  appended to the tamper-evident audit chain, so verification decisions are
  greppable and reviewable.
- **Configuration** — maker-checker is **always on and unconditional** for
  high-risk operations (filesystem mutations, destructive/privileged/network/
  exfiltration shell bands, generated-tool activation). Per the acceptance
  contract (US-15.1) it is *not* gated behind an env flag — the maker cannot
  self-certify, so there is no opt-out. It degrades gracefully: if the checker
  cannot run, the change falls back to the existing user-approval gate and is
  logged, never silently applied.
- **Ambient completion check (US-13.5)** — the same `runChecker` primitive is
  reused at task completion in full mode (no target filter) to catch
  integration regressions the per-change targeted checks miss; a `revise`/
  `reject` injects the evidence and continues the loop (self-heal) up to
  `QUIVER_AMBIENT_MAX_ROUNDS` (default 5). There is no second `tsc`/`npm test`
  pipeline — one primitive, two scopes (per-change targeted + completion full).

This is the same maker-checker discipline used to accept the vendor's delivery:
the checker owns the acceptance contract (`tests/spec_acceptance_tests.ts`) and
the maker implements against it — so the product ships with the verification
discipline it was built under.
