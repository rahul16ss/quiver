# Quiver Spec Acceptance Contract (Checker-Owned)

**QA is a checker concern.** The maker (vendor) does **not** ship a
self-authored test suite — a maker-authored suite can be fitted to the maker's
own code and is not credible acceptance evidence. The maker's only QA role is
to raise, in writing, genuine practical difficulty meeting the criteria below.
The single acceptance gate is:

```bash
npm test                       # runs tests/spec_acceptance_tests.ts; exits 1 until all checks pass
npx tsx tests/run_tests.ts     # equivalent
```

`tests/spec_acceptance_tests.ts` asserts against `.spec-swimlane.md`, **not**
against the vendor's shipped code. The live failing list is mirrored in
`.spec-swimlane.md` → "Vendor Acceptance Status (Live)".

## Status: 89 / 89 checks met — all green (exit 0)

The checker ran the product itself (first run in a clean cwd with no keys,
`--version/--help`, `npm run gui`, malformed inputs). As of the final audit run
against the current working tree, all 89 checks pass.

**Approved user-facing env variable set (project-owner directive).** `.env.example`
and the codebase's user-facing env surface may use **only**:
- Core (10): `LLM_API_BASE_URL`, `LLM_MODEL_NAME`, `OLLAMA_API_KEY`,
  `VISION_MODEL_NAME`, `VISION_MODEL_BASE_URL`, `REQUIRE_APPROVAL_FOR`,
  `QUIVER_MAX_CONTEXT_TOKENS`, `BROWSER_HEADLESS`, `QUIVER_SESSION_LOG`,
  `QUIVER_SESSION_LOG_MAX_CHARS`.
- Optional: `PARALLEL_API_KEY`, `GITHUB_TOKEN` (developers only).
- Retired (must not appear): `LLM_API_KEY`, `VISION_MODEL_API_KEY`,
  `CONTEXT7_API_KEY`.
- Single API key = `OLLAMA_API_KEY`, powering LLM + Ollama + vision.

**Checks this audit added/revised (now met — do not regress):**

- `ONBOARDING-HANDSHAKE` (US-1.1) — first run launches the conversational
  handshake (`⚡ Welcome to Quiver! … Enter your Ollama API key …`) instead of
  the old static `1. quiver init / 2. Add … / 3. quiver` block + `exit(3)`.
- `CONFIG-MODEL-DEFAULTS-IN-SOURCE` (US-1.3) — `src/config.ts` bakes non-empty
  model-name defaults (`glm-5.2:cloud`, `gemma3:4b`); model names are
  source-controlled, never required from the user.
- `CONFIG-ENV-ALLOWLIST` (US-1.3) — `.env.example` + the codebase use only the
  approved variable set; `LLM_API_KEY`/`VISION_MODEL_API_KEY`/`CONTEXT7_API_KEY`
  are retired and absent.
- `CONFIG-SINGLE-API-KEY` (US-1.3) — a single `OLLAMA_API_KEY` powers the LLM,
  Ollama, and vision adapters; onboarding persists `OLLAMA_API_KEY=`.
- `TOOL-SCAN-NO-INFRA-WARNINGS` (US-5.2), `STATUS-LINE-NUMBER-FORMAT` (US-2.5),
  `GUI-IMPORTS-RESOLVE` (US-8.1) — startup is warning-free, numbers are
  locale-stable (`120,000`), and the GUI launches.
- `MAKER-CHECKER-MODULE/SEPARATION/SPEC-AWARE/AUDIT-OVERRIDE` (US-15.1–15.4) —
  `src/subagents/checker.ts` implements the isolated checker (read-only /
  no-network / no-env), `approve|reject|revise` verdict, spec-aware verification
  against this contract, and audit-chain + user override.
- `SECRET-SCHEMA-USES-REFS` (US-1.3) revised — the versioned config schema now
  declares `api_key_ref: "OLLAMA_API_KEY"`, consistent with the renamed
  `src/config.ts`.
- `VISION-CONFIG-WIRED` (US-5.4) revised — vision is wired via
  `VISION_MODEL_NAME`/`VISION_MODEL_BASE_URL`; the vision key is the single
  `OLLAMA_API_KEY` (no retired `VISION_MODEL_API_KEY`).

> **Already met (the other 78, do not regress):** all 11 cloud-sync checks
> (opt-in + AES-256-GCM + exclusions + atomic write; verified no leak via
> `quiver cloud-sync`; contract proven to fail the old leaky code on 9 sync
> checks), plus command-approval-cwd, secret handling, session-list metadata,
> vision (behavioral EXIF/downscale/remote-consent), retry idempotency,
> untrusted wrapping, memory review, GUI source-level wiring, homebrew sha256,
> `tsc --noEmit`.

> **⚠️ User's deployed build is behind.** The user's terminal still shows the
> old pre-fix UX (`⚠️ Skipped runtime.ts/sandbox.ts`, `1,20,000`, the first-run
> dead-end, separate keys in `.env`). Rebuild/reinstall Quiver from the current
> tree so the user gets the fixed behavior. The contract now enforces all of
> the above so they cannot regress once shipped.

> **`.env` note:** the checker never writes `.env` and the contract runs the
> onboarding check in a throwaway temp cwd. Do not store real keys in
> `/Users/rahul/quiver/.env` (a committed template that tooling may reset); use
> the OS keychain or a `.env` outside the repo.

## Maker-checker (Epic 15)

The spec defines a maker-checker separation (Tenet 6 + Epic 15) so that, going
forward, every unit of work is independently verified against these acceptance
criteria before commit — automating the checker role this contract performs
manually today.

## What changed vs. the vendor's old suite

The vendor's self-authored tests (`tests/spec_conformance_tests.ts`,
`tests/unit/`, `tests/adapters/`, `tests/e2e/`, `tests/lifecycle_tests.ts`,
`tests/module_tests.ts`, `tests/epic1_tests.ts`, `tests/stream_retry_tests.ts`)
were **removed** — they passed today despite the code violating the spec (e.g.
testing `ELECTRON_HARDENING_RULES.sandbox` while `ui/main.ts` never sets
`sandbox: true`; testing `shouldExcludeFromSync(".env")` while raw logs and
screenshots sync unencrypted). The legitimate, spec-grounded checks they
happened to cover were absorbed into the checker contract so coverage is not
lost.
