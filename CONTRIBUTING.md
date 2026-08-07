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
npm run check      # Serial gate: format + lint + typecheck + build + tests + daemon smoke
npm test            # Checker-owned acceptance contract + harness gate — must stay green
npm run demo:ic-memo # Flagship workflow demo (8/8 checks, no network needed)
npm start           # Loopback browser UI via harness daemon (compiled dist/)
```

Never run two npm commands concurrently in the same checkout — concurrent
commands can mutate `node_modules` underneath each other and produce phantom
module-resolution failures. `npm run check` is deliberately serial.

## The acceptance contract

`tests/spec_acceptance_tests.ts` is the single source of truth for what "done" means. It is **checker-owned** — you adapt your code to satisfy the checks, not the other way around. Never edit tests to pass; fix the implementation.

The contract asserts against `SPEC.md` and `docs/product/user-stories.md`, not against your shipped code. Read both before changing anything non-trivial.

## Before submitting a PR

1. `npm run check` green (includes `npm test` and `tsc --noEmit`)
2. No new lint errors (warnings in legacy files are a tracked ratchet — see docs/status/READINESS.md)
3. `npm run demo:ic-memo` 8/8
4. If you changed the browser UI, do a visual walkthrough (launch → send/workflow → approval → deliverable card → session resume → settings) and read the screenshots. "Tests green" has shipped a broken UI before.
5. No secrets in code, commits, or diffs. API keys live in the OS keychain or `.env` (gitignored). Prefer `OPENROUTER_API_KEY` for cloud; `LLM_API_*` for local/private.
6. Commits are signed `Co-Authored-By: Quiver <quiver@convictionstudio.com>` — never an AI/Claude trailer.

## Public claims discipline

Public claims (README, website, demos) are governed by the capability truth table in the Conviction Studio repo. Never claim: data stays local by default, Quiver-signed ZDR, "compliance-ready", or "100% cited". See `AGENTS.md` for the full rules.

## Architecture

See `docs/architecture.md` for the system map and `SPEC.md` for the technical spec. The short version:

- **One verification primitive**: the maker-checker (`src/subagents/checker.ts`) runs the acceptance contract on an isolated scratchpad. Per-change (targeted) + completion (full) reuse the same primitive.
- **Provider-agnostic**: no model name, base URL, or API key is baked into the source. Everything reads from `.env` / the OS keychain.
- **The ambient goal-loop** (always-on) verifies completed work and self-heals. There is no manual loop command.

## License

Apache-2.0. By contributing, you agree your contributions are licensed under the same terms.
