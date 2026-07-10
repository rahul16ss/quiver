# Working on Quiver — read this first

**Source of truth for cross-project context, decisions, conventions, and
current state: `/Users/rahul/PROJECTS.md`** (on the owner's machine — this
repo is one half of a two-project system with the Conviction Studio website).
Read it fully before changing anything, and update it when you finish.

Repo-local canon:
- `docs/product/user-stories.md` — **the design source.** Personas, journey,
  acceptance moments, screen inventory, and the definition of "Apple-grade".
  No buyer-surface (GUI) work proceeds ahead of these stories; screens are
  designed from the storyboard, not from defect lists.
- `spec-quiver-harness.md` — the technical spec (architecture + mechanism).
  **§19 "Current State & Build Order"** is the authoritative status table and
  the only section allowed to change with reality. Build in §19's order.
- `docs/qa/` — GUI QA method. The desktop app is the one buyer surface.

Hard rules:
1. `npm test` (checker-owned acceptance contract) is **read-only** — never
   edit tests to pass; adapt the implementation to the check's intent.
2. Release gate: `npm test` green · `npx tsc --noEmit` clean ·
   `npm run demo:ic-memo` 8/8 · a **visual** GUI walkthrough (launch → send →
   approval → deliverable card → session resume → settings) with screenshots
   you actually read. "Tests green" has shipped a broken GUI before.
3. Public claims are governed by the capability truth table in the Conviction
   Studio repo. Never claim: data stays local by default (default model
   endpoint is Ollama cloud), redaction/sensitivity routing, live lineage
   during drafting, ZDR, or "compliance-ready". Cell lineage is claimable only
   for Excel-sourced figures in `examples/investment-committee-memo/`.
4. Business surfaces say **Draft only / Draft and research / Assisted** —
   never "yolo" (internal alias only, see `docs/advanced.md`).
5. Commits are signed `Co-Authored-By: Quiver <quiver@convictionstudio.com>`
   — never an AI/Claude trailer.
6. GUI-spawned agents must never write into this repo (QUIVER_PROTECTED_DIR
   hard block) — keep that guard and its negative test intact.
