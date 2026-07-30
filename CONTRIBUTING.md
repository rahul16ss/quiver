# Contributing to Quiver

Quiver is an open foundation for controlled, source-backed document workflows in finance. Contributions are welcome.

## Setup

```bash
git clone https://github.com/rahul16ss/quiver.git
cd quiver
npm install
```

## Development

```bash
npm test            # Checker-owned acceptance contract — must stay green
npx tsc --noEmit    # TypeScript clean
npm run demo:ic-memo # Flagship workflow demo (8/8 checks, no network needed)
npm run gui         # Launch the desktop app (Electron)
```

## The acceptance contract

`tests/spec_acceptance_tests.ts` is the single source of truth for what "done" means. It is **checker-owned** — you adapt your code to satisfy the checks, not the other way around. Never edit tests to pass; fix the implementation.

The contract asserts against `SPEC.md` and `docs/product/user-stories.md`, not against your shipped code. Read both before changing anything non-trivial.

## Before submitting a PR

1. `npm test` green
2. `npx tsc --noEmit` clean
3. `npm run demo:ic-memo` 8/8
4. If you changed the GUI, do a visual walkthrough (launch → send → approval → deliverable card → session resume → settings) and read the screenshots. "Tests green" has shipped a broken GUI before.
5. No secrets in code, commits, or diffs. API keys live in the OS keychain or `.env` (gitignored).
6. Commits are signed `Co-Authored-By: Quiver <quiver@convictionstudio.com>` — never an AI/Claude trailer.

## Public claims discipline

Public claims (README, website, demos) are governed by the capability truth table in the Conviction Studio repo. Never claim: data stays local by default, ZDR, "compliance-ready", or "100% cited". See `AGENTS.md` for the full rules.

## Architecture

See `docs/architecture.md` for the system map and `SPEC.md` for the technical spec. The short version:

- **One verification primitive**: the maker-checker (`src/subagents/checker.ts`) runs the acceptance contract on an isolated scratchpad. Per-change (targeted) + completion (full) reuse the same primitive.
- **Provider-agnostic**: no model name, base URL, or API key is baked into the source. Everything reads from `.env` / the OS keychain.
- **The ambient goal-loop** (always-on) verifies completed work and self-heals. There is no manual loop command.

## License

Apache-2.0. By contributing, you agree your contributions are licensed under the same terms.