# Quiver Testing

## Acceptance model

Acceptance is **checker-owned**, not vendor-authored. The single source of
truth is the acceptance contract:

```
tests/
├── run_tests.ts               # Entry point — delegates to the contract
├── spec_acceptance_tests.ts   # Checker-owned acceptance contract (read-only to the vendor)
└── ACCEPTANCE_CONTRACT.md     # Human-readable mirror of the contract
```

The maker does **not** ship a self-authored test
suite — a maker-authored suite is fitted to its own code and is not credible
acceptance evidence. The contract asserts the spec
(`SPEC.md`, the private technical spec on the owner's machine — not the shipped code), and
many checks are behavioral: they drive real code paths and assert outcomes, so
keyword placement in comments will not pass them.

## Running the gate

```bash
npm test          # = npx tsx tests/run_tests.ts
```

The gate exits non-zero while any check is unmet. A green run prints
`All <N> spec acceptance checks met.`

## Definition of Done

A user story is accepted when:
- `npx tsc --noEmit` passes with no warnings or errors (`TSC-CLEAN`).
- Every check in `tests/spec_acceptance_tests.ts` is met.
- Security, user data ownership, explicit consent, and inspectable-state
  requirements are satisfied (non-negotiable per the spec).

## What the contract covers

The contract spans the full blueprint: first-run onboarding, config/secret
hygiene (single-key model, keychain, env allowlist), lifecycle hooks, context
compaction, memory extraction/review/privacy, vision routing, retry policy,
untrusted-content wrapping, path sandboxing, secret redaction, audit chain,
diff/atomic-write safety, prompt assembly, token budgeting, tool sandbox
manifest, subagent recursion limits, diagnostics, Electron GUI hardening
(sandbox/CSP/window-state/IPC), adapter conformance, config schema
validation/migration, Homebrew formula, cloud sync (opt-in, encrypted,
consent-gated), and the maker-checker verification discipline.

If you believe a check is wrong, raise it in writing — do not edit the
contract.

## Integration & Wiring (part of the single gate)

A module that exists yet is never imported by the real agent loop is worth
nothing. The acceptance contract therefore contains `WIRE-*` integration checks
that drive the real `src/agent.ts` loop and the tools and prove the architecture
is actually wired in — not just present on the workbench. They run as part of
`npm test` (there is no separate wiring suite).

```
tests/
└── spec_acceptance_tests.ts   # THE acceptance contract (checker-owned) — `npm test`
```

```bash
npm test   # = npx tsx tests/run_tests.ts — the single acceptance gate
```

It covers:

- **Agent-loop wiring** (`WIRE-*`, structural) — `agent.ts` imports and fires
  lifecycle (`wrapModelCall`/`wrapToolCall`), sources model transport via
  `getActiveProvider().streamChat()` (no inline `fetch`), selects the adapter via
  `getAdapterForModel()`, builds the prompt through `assemblePrompt()`, applies
  `calculateBudget()`/`shouldBlockSubmission()`, uses `FileReadHistory` (not a
  `Set<string>`), classifies `run_command` via `classifyCommand()`, writes
  per-turn checkpoints, tracks consecutive failures, and parses memory citations.
- **Tool security** — the path sandbox actually blocks `.env` and `~/.ssh`
  writes and refuses outside-workspace writes; `run_command` classifies risk
  bands and outside-workspace targets.
- **File integrity** — atomic writes create backups and support rollback;
  hash + mtime compare-and-swap blocks stale/unread writes.
- **Spec-gap checks** — the criteria the prior 89-check contract omitted
  (project.json schema, first-run core.json, subcommand bypass, crash prompts,
  `/logs`, `/rollback`, create_tool disabled-by-default, session schema, docs,
  landing page, moderate command band, blocked globs, CoW scratchpad, behavioral
  untrusted wrap).

> This contract is checker-owned and read-only to the vendor; `npm test` is the
> only live verdict — re-run it for the current status. Defense-in-depth: the
> checker's `noNetwork`/`readOnly` are env signals + scratchpad cwd, not OS-level
> socket blocking — see `tests/ACCEPTANCE_CONTRACT.md`.
