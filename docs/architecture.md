# Quiver Architecture

## Overview

Quiver is a local-first, inspectable AI coding and research harness built around five primary architectural systems:

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
│   ├── config.ts             # Configuration loading (.env + global config)
│   ├── context_manager.ts    # LLM summarization, context offloading, compaction
│   ├── context_manifest.ts   # HUD display before model calls
│   ├── lifecycle.ts          # Lifecycle hooks (beforeAgent, beforeModel, etc.)
│   ├── paths.ts              # Filesystem path resolution (~/.quiver/projects/)
│   ├── registry.ts           # Tool registry, dynamic loading
│   ├── state.ts              # Core memory load/save, agent file export
│   ├── session_logger.ts     # Session logging with secret redaction
│   ├── vision_router.ts      # Vision fallback routing for multimodal models
│   ├── tool_selector.ts      # LLM-powered tool selection
│   ├── adapters/             # Harness adapter contract (Model-Harness-Fit)
│   ├── providers/             # Model provider abstraction (transport layer)
│   ├── security/              # Path policy, command classification, secrets
│   ├── prompts/               # Security preamble, untrusted content wrapping
│   ├── session/               # File access tracking, schema, checkpoints
│   ├── memory/                # Schema, review queue, privacy, citations, decay
│   ├── context/               # Token budgeting
│   ├── prompt/                # Deterministic prompt assembly
│   ├── fs/                    # Atomic writes with rollback
│   ├── subagents/             # Parallel subagent pool, sandbox, types
│   └── tools/                 # All tool implementations + sandbox
├── ui/                       # Electron GUI (main, preload, renderer)
├── docs/                     # Documentation, landing page, threat model
├── tests/                    # Checker-owned acceptance contract (spec_acceptance_tests.ts)
└── Formula/                  # Homebrew formula
```

## Data Flow

```
User Input
  → Context Manager (load memory, skills, project context)
  → Tool Selector (select relevant tools via LLM)
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
```

## Security Layers

1. **Path Sandbox** — All file operations constrained to workspace root
2. **Command Classification** — Shell commands classified by risk band
3. **Secret Redaction** — Secrets detected and redacted before logging/transmission
4. **Read-Before-Write** — SHA-256 hash verification prevents stale overwrites
5. **Prompt Injection Defense** — Untrusted content wrapped in XML boundaries
6. **Tool Sandbox** — Dynamic tools execute in isolated worker threads
7. **Atomic Writes** — Temp-write-then-rename with backup and rollback
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
- **Configuration** — maker-checker is always on for high-risk operations
  (filesystem mutations, destructive/privileged/network/exfiltration shell
  bands, generated-tool activation) and opt-in for the full session
  (`QUIVER_MAKER_CHECKER=on`). It degrades gracefully: if the checker cannot
  run, the change falls back to the existing user-approval gate and is logged,
  never silently applied.

This is the same maker-checker discipline used to accept the vendor's delivery:
the checker owns the acceptance contract (`tests/spec_acceptance_tests.ts`) and
the maker implements against it — so the product ships with the verification
discipline it was built under.
