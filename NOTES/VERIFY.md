# Verification commands and baseline receipts

All commands below were executed with an explicit `cd /Users/rahul/quiver`.
Raw receipts are in `/tmp/`.

| Command | Exit | Receipt | Result |
|---|---:|---|---|
| `cd /Users/rahul/quiver && npm ci` | 0 | `/tmp/quiver-baseline-install.log` | install/audit passed; 0 vulnerabilities |
| `cd /Users/rahul/quiver && npm test` | 0 | `/tmp/quiver-baseline-test.log` | 459 spec checks and all harness checks passed |
| `cd /Users/rahul/quiver && npx tsc --noEmit` | 0 | `/tmp/quiver-baseline-tsc.log` | TypeScript clean |
| `cd /Users/rahul/quiver && npm run test:e2e:a` | 0 | `/tmp/quiver-baseline-e2e.log` | Tier A: 24 passed, 0 failed |
| `cd /Users/rahul/quiver && npm run test:e2e:all` | 1 | `/tmp/quiver-baseline-e2e-all.log` | 38 passed, 1 failed: live single-turn connection failure at `127.0.0.1:9223/v1`; live environment unavailable |
| `cd /Users/rahul/quiver && npm run demo:ic-memo` | 0 | `/tmp/quiver-baseline-demo-ic.log` | flagship demo 8/8 |
| `cd /Users/rahul/quiver && npm run demo:post-earnings` | 0 | `/tmp/quiver-baseline-demo-post.log` | 6/6 |
| `cd /Users/rahul/quiver && npm run demo:portfolio-review` | 0 | `/tmp/quiver-baseline-demo-portfolio.log` | 6/6 |
| `cd /Users/rahul/quiver && npx tsx scripts/daemon_smoke.ts` | 0 | `/tmp/quiver-baseline-daemon.log` | all smoke checks passed |
| `cd /Users/rahul/quiver && npm run lint` | 1 | `/tmp/quiver-baseline-lint.log` | no `lint` script exists |
| `cd /Users/rahul/quiver && npm run build` | 1 | `/tmp/quiver-baseline-build.log` | no `build` script exists |

## Exact stack discovery

- Node/TypeScript ESM project.
- `package.json` has `test`, `test:e2e`, `test:e2e:all`, demo, and harness scripts.
- No `lint` or `build` script is currently defined; these are explicit tooling gaps, not skipped commands.
- `package-lock.json` exists; `npm ci` was run successfully.

## External changes verified at baseline

- `d4fec96`, `b8e95c1`, and `9f7810e` are present on `main`.
- The current repository-root `npm test` and `tsc` pass with those changes.
- Tier-A and deterministic demos pass.
- Full live E2E is not green because one live endpoint connection failed; the receipt is preserved above.

## Remaining verification required

1. Run targeted tests for the external per-step checker rejection and planner revision branches; baseline `npm test` passing does not prove those branches are exercised.
2. Run UI/browser visual QA from the current external `runs.js` surface, not only static tests.
3. Run opt-in live contract suite with real OpenRouter/Parallel/Graph/Drive/OfficeCLI credentials, or record each unavailable prerequisite explicitly.
4. Add a lint/check/build script or document an owner-approved alternative if the project release gate requires those commands.
