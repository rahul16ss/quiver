# Working on Quiver — read this first

**Source of truth for cross-project context, decisions, conventions, and
current state: `/Users/rahul/PROJECTS.md`** (on the owner's machine — this
repo is one half of a two-project system with the Conviction Studio website).
Read it fully before changing anything, and update it when you finish.

Repo-local canon:
- `docs/product/user-stories.md` — **the design source.** Personas, journey,
  acceptance moments, screen inventory, and the definition of "Apple-grade".
  No buyer-surface work proceeds ahead of these stories; screens are
  designed from the storyboard, not from defect lists.
- `SPEC.md` — the technical spec (architecture + mechanism). Private: it
  lives on the owner's machine (gitignored), not in the public repo.
  **§19 "Current State & Build Order"** is the authoritative status table and
  the only section allowed to change with reality. Build in §19's order.
- `NOTES/FINISH_LINE.md` — engineering finish-line / handoff status for the
  production harness refactor (what is wired vs external-blocked).
- `docs/qa/` — browser-UI QA method. The buyer surface is the **loopback
  browser UI** served by the harness daemon (`src/harness/ui/`). Electron
  and `npm run gui` are removed.

Hard rules:
1. `npm test` (checker-owned acceptance contract) is **read-only** — never
   edit tests to pass; adapt the implementation to the check's intent.
2. Release gate: `npm test` green · `npx tsc --noEmit` clean · all three
   reference workflow demos passing · daemon smoke · a **visual** browser-UI
   walkthrough (launch → send/workflow → approval → deliverable card →
   session resume → settings) with screenshots you actually read. "Tests
   green" has shipped a broken UI before.
3. Public claims are governed by the capability truth table in the Conviction
   Studio repo. Never claim: data stays local by default (the model endpoint
   is user-configured — OpenRouter cloud is the usual shared path),
   Quiver-signed ZDR, or "compliance-ready". OpenRouter ZDR routing prefs are
   enforced in code when that path is used — that is not a customer ZDR
   contract and must not be marketed as one. Sensitivity routing and
   redaction exist as engagement-configured, fail-closed controls
   (missing/invalid `.quiver/sensitivity.json` refuses the turn); public
   wording must still use the truth-table umbrella — "Data handling and
   model use are configured around the workflow's sensitivity". Never claim
   live lineage during drafting as a universal property. Cell lineage is
   claimable only for Excel-sourced figures in
   `examples/investment-committee-memo/`.
4. Business surfaces say **Draft only / Draft and research / Assisted** —
   never "yolo" (internal alias only, see `docs/advanced.md`).
5. Commits are signed `Co-Authored-By: Quiver <quiver@convictionstudio.com>`
   — never an AI/Claude trailer.
6. Agents must never write into this repo when `QUIVER_PROTECTED_DIR` is set
   (hard block) — keep that guard and its negative test intact.

The shared operating principles (including the Associate/VP maker-checker
model and honesty boundaries) are in [`docs/principles.md`](docs/principles.md).
