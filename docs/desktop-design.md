# Quiver Desktop — design authority (moved)

This document is retired. GUI design authority is consolidated in one place:

- **`docs/product/user-stories.md`** — personas, journey, acceptance moments,
  screen inventory, per-screen briefs (added as each screen's cycle starts),
  the North Star, and the definition of "Apple-grade". **The design source.**
- **`SPEC.md`** (private, owner's machine) Epic 2 (in §14) — the retained mechanical
  contract (idle launch, approval previews, deliverable card, workspace
  safety, honest surfaces); §19 — implementation status.
- **`docs/qa/`** — the visual verification method every release runs against.

Principles that lived here are absorbed into the stories document: the North
Star (a user always knows what the AI is seeing and what it is doing — never
labeled "audit log"); plain-language translation of internals ("tool_call" →
"Quiver is editing a file", "context window" → "memory this session"); the
banned words on buyer surfaces (*terminal*, *.env*, *endpoint*, *API*);
reversible-by-default with loud irreversible actions (typed confirmation for
the irreversible); mid-run steering (Esc to inject, Stop to halt); memory as
editable cards with the review queue; Mac+Windows one codebase;
Quiver-branded, Apache-2.0 forever; single key in the OS keychain;
zero-config onboarding with a guided first task; and the anti-goals (not a
chat clone, not a developer tool in disguise, no tabs that hide transparency,
no privacy claims the product doesn't run).

Retired 2026-07-10 to keep a single design authority.
