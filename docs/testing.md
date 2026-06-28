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

Per `.spec-swimlane.md`, the maker does **not** ship a self-authored test
suite — a maker-authored suite is fitted to its own code and is not credible
acceptance evidence. The contract asserts the spec (not the shipped code), and
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
- Security, local-first behavior, user data ownership, explicit consent, and
  inspectable-state requirements are satisfied (non-negotiable per the spec).

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
