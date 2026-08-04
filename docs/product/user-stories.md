# Quiver — User Stories & Storyboard

**Status: Living design source (updated 2026-08-04).** This document owns
"what it must feel like." The technical spec (`SPEC.md`, private on the owner's
machine) owns architecture and status. `CONTRIBUTING.md` and the acceptance
contract assert against the moments below — keep them honest.

The quality bar, stated once: every story's acceptance criteria are
**observable moments** — things a named person sees, clicks, or feels on a
deadline. If a screen element doesn't serve a moment below, it does not ship.
That discipline — not more polish passes — is what "Apple-grade" means here.

---

## The people

- **Priya — the preparer.** PE associate, 27. IC memo due Thursday; it's
  Monday. Lives in Excel and Word. Has been burned by AI inventing numbers.
  Will use Quiver only if it saves her hours *and* never embarrasses her.
- **Marcus — the signer.** Partner, 51. Reads the memo Wednesday night. His
  name goes on it. He doesn't care about AI; he cares whether the $48.2m ties
  to the model and whether anyone checked customer concentration. Gives the
  product 90 seconds to earn trust.
- **Dana — the owner.** Ops/associate who runs the workflow after Conviction
  Studio hands it over. Not an engineer. Needs to rerun it quarterly, swap the
  template, and know when something drifted.

## The journey (one sentence)

Priya gives Quiver the deal materials Monday; it drafts the memo in the
firm's format with every figure traceable; Priya resolves the flags Tuesday;
Marcus verifies and signs Wednesday; Dana reruns it next quarter without
calling anyone.

---

## Moment 1 — Opening with confidence (Priya, Monday 8:02am)

**S1. "I can start immediately."**
As Priya, when I open Quiver, I can type my ask within two seconds — nothing
is greyed out, nothing is spinning, nothing asks me to configure anything.
- ✅ Built: idle launch state, Send always available, suggestion chips.
- Acceptance moments: window opens → composer focused → one obvious primary
  action. No dashes, no empty progress bars, no jargon anywhere on screen.

**S2. "I know exactly what it knows — and I can change it."**
As Priya, I can see — in my language — what context Quiver will use: the
firm's template, prior memos, my files, and where my prompts go (cloud/local),
before I share anything sensitive. And it's a control, not a display: I can
exclude a file or memory from this run in one click, and the exclusion is
recorded.
- ✅ Built: six-layer context rail with honest locality line; consent gate is
  **default-on and fail-closed** in the finance-client profile — it surfaces
  before a run and blocks until approved/declined/excluded; exclude-before-run
  reaches the agent (context-rail veto → `memory:exclude` →
  `QUIVER_EXCLUDED_MEMORIES` → agent skips the file).
- Gap to Apple-grade: the rail still reads like an inspector more than a
  sentence. Prefer one calm summary line ("Using your IC template, 2 memory
  files, 33 tools · prompts stay on this machine / go to your configured
  model") that expands on demand into items with exclude toggles.

## Moment 2 — Giving it the deal (Priya, Monday 8:05am)

**S3. "I hand it my mess."**
As Priya, I drag in the CIM, the model (v12, not v11), the transcript, and my
notes, say "first-pass IC memo, our template," and Quiver confirms what it
received — files, sheets it can read, what it will NOT use.
- 🟡 Partial: drag-drop images exists; file attachments beyond images and a
  "received your inputs" confirmation moment do not.
- Acceptance moments: drop 4 files → see 4 named cards with type icons →
  Quiver states its plan in 2 lines → Priya hits Go. Any unreadable file is
  flagged *now*, not discovered Thursday.

**S4. "It asks before anything that matters — once, intelligibly."**
As Priya, when Quiver needs permission, the ask names the action, the target,
and shows me the content; saying yes once covers the obviously-similar
follow-ups. I am never asked to approve something I cannot see.
- ✅ Built: rich approval previews, file-scoped approval cache, diff previews.
- Guard that must never regress: blind approvals are release-blocking;
  self-modification is hard-blocked.

## Moment 3 — Watching it work without babysitting (Priya, Monday, background)

**S5. "I can glance, understand, and steer."**
As Priya, mid-run I can glance at Quiver and know: what it's doing now, what
it produced so far, and whether it's stuck — the way I'd glance at a junior
across the desk. When it verifies its own work I see that too ("Verifying…
✓ 5 checks passed" / "Found an issue — fixing…"), never a stack trace. And I
can interrupt: my typed message is queued and injected, Stop halts cleanly.
- ✅ Built: activity feed with timestamps (honest, log-like); Stop works;
  Esc-steering in the CLI path; a single current-status line above the feed
  ("Reading RevenueBuild sheet…") is wired to tool events; checker
  verification surfaced in plain language. Queued-typing steering shipped
  in the GUI (type while running → message queued and sent to the agent's
  InterventionController). The activity pane captions the trail as
  tamper-evident (hash-chained).

**S6. "Closing my laptop costs nothing."**
As Priya, I can close the window Monday evening and reopen Tuesday — the
conversation, the draft, and the run state are exactly where I left them.
- ✅ Built: daemon stage 1, verified by kill test; session resume renders
  full transcripts.

## Moment 4 — Receiving the deliverable (Priya, Tuesday 9:00am)

**S7. "The memo lands in MY world."**
As Priya, the output is a .docx in the firm's template that I open in Word —
not a chat blob. The handoff moment is unmistakable: a document card with the
file name, and one click to open or reveal it.
- ✅ Built: deliverable card (Open / Show in Folder / Preview); native docx
  via officecli, template-driven (proven in the flagship example). Cards stay
  in evidence-pending until the evidence hard gate clears — no ready flash;
  workflow-demo cards use the same lifecycle as agent-produced documents.
- Gap to Apple-grade: the card is functional, not celebratory. This is the
  product's money shot — it should feel like receiving work, not a download
  notification (document thumbnail/first-page preview, section count, and
  the flag count that leads Priya into Moment 5).

**S8. "The draft never bluffs."**
As Priya, every number in the draft is sourced or visibly flagged — the memo
tells me what it does NOT know (unresolved items) instead of papering over it.
- ✅ Built: fully real in the flagship example (evidence model + 8 checks,
  Excel cells verified by read-back) AND generated live during drafting —
  the `evidence` tool emits structured Evidence.json from a real agent run,
  the checker rejects unsourced quantitative figures (evidence hard gate),
  and `npm run demo:ic-memo:live` proves the trust story renders from live
  output (8/8).

## Moment 5 — Verifying before signing (Marcus, Wednesday 9:40pm — the 90 seconds)

**S9. "Show me where the number came from."**
As Marcus, I click $48.2m and see the source in place: Model_v12.xlsx,
RevenueBuild, the cell, its value — without opening Excel. I click the
concentration claim and see the transcript excerpt. Two clicks, ten seconds.
- ✅ Built: lineage chips render in the desktop GUI from live agent output;
  clicking a chip opens the verification rail showing the source in place
  (Excel cell with sheet/cell/value, filing excerpt, or web URL). This is the
  moment the entire trust story exists for — the demo climax.

**S10. "My review is the record."**
As Marcus, I mark each key figure verified / flagged / needs-analyst; the memo
cannot be marked final while flags are open (an override is possible and
logged). My checks become the review record that goes with the memo.
- ✅ Built: per-document review flow in the desktop GUI — mark each figure
  verified / flagged / needs-analyst; mark-final is blocked while open flags
  exist; override is logged to a per-document tamper-evident audit chain and a
  review record is written next to the deliverable.

**S11. "What was it fed?"**
As Marcus, in one click I see what informed this draft — files, sources,
excluded material, and where prompts went — so I can answer compliance
without a meeting.
- ✅ Built: context rail + run record artifact exist, and a per-deliverable
  "context used for this document" view opens from the deliverable card
  (inputs, sources, excluded sources, run record) populated from the evidence
  tool's structured output.

## Moment 6 — Running it again (Dana, next quarter)

**S12. "Rerun without ceremony."**
As Dana, I open last quarter's session, point at the new model file, and run
the same workflow; acceptance checks tell me it worked. If the model's
structure changed, Quiver halts and tells me what moved — it never silently
produces a wrong memo.
- ✅ Built: workflow.yaml + acceptance checks + rerun exist for the
  flagship example. GUI "run this workflow again" affordance shipped (a
  Run Workflow Demo button in the empty state + IPC handler). Drift
  detection shipped (`src/workflow/drift.ts` + `expected-structure.json`).

**S13. "The firm owns it."**
As Dana, the workflow definition, template config, runbook, and training
materials are mine after handover; I can change the template without breaking
lineage, and I know how to stop the workflow and report a defect.
- ✅ Built (as service assets): runbook/training/handover templates, workflow
  artifact. Product affordances (template swap in-app) intentionally deferred.

## Moment 7 — Trusting it with the firm (the differentiators, lived)

These three stories ARE the moat. Every competitor demo can draft a memo;
none of them can survive these three questions from Marcus. If a release
strengthens features but not these, it strengthened the wrong thing.

**S14. "The firm's memory is the firm's."**
As Dana, everything Quiver has learned — house style, preferences, workspace
facts, the persona — lives in plain files I can open, edit, and delete; a
praised memo can be promoted into an example the next memo learns from; and
none of it is hostage to a vendor. When we improve the instructions, the next
quarter's memo is visibly better: institutional knowledge compounds.
- ✅ Mostly built: plain-file memory + review queue + GUI editing built; versioned
  memory with diff/rollback shipped (US-17.19, `src/memory/versioned.ts`); the
  episodic examples store shipped (`src/memory/examples_store.ts` +
  `examples` tool). Continual learning enqueues into the structured facts.jsonl
  review pipeline. The *ownership* and *compounding* are both real today.
- Acceptance moments: Dana opens memory as normal files; edits survive and
  visibly shape the next run; promoting an example is one action.

**S15. "Sensitive deals stay inside the line."**
As Priya on a live deal, I mark the data room material sensitive; Quiver
shows me — before running — what would leave the machine and what stays
local, strips the names it was told to strip (and shows me the receipt), and
refuses to send configured MNPI to any remote model. When compliance asks,
the run record answers.
- ✅ Built (framework + fail-closed default): honest locality disclosure and
  the run-record exist; redaction (`redactMnpi`), sensitivity routing
  (classify/route, wired into the agent loop), and the redaction receipt
  exist. Engagement config lives at `.quiver/sensitivity.json` — without a
  valid config the agent refuses rather than guessing. Per-engagement
  patterns and tiers remain engagement work; no marketing may imply a
  turnkey compliance product.
- Acceptance moments: mark-as-sensitive is one action; the pre-run summary
  says "3 client names redacted, model note stays local"; an attempted
  remote send of MNPI is refused and logged.

**S16. "Never trapped."**
As the firm, if we switch model providers next year, nothing that matters
moves: memory, sessions, skills, templates, workflows, and the audit trail
are ours in files; the model is a rented calculator we can swap.
- 🟡 Partial: two adapters over one interface, source-controlled model
  config, everything durable already in files. Not yet *demonstrated* as a
  moment (a provider-swap walkthrough) — worth one runbook page and a demo
  beat, since "never trapped" is a pitch line the truth table gates.
- Acceptance moments: change provider in Settings → same session, same
  memory, same workflows; the swap is boring.

---

## The screen inventory (everything else is cut)

Five screens, each owned by a moment:
1. **Home / composer** (S1, S2, S3) — one calm context sentence, composer,
   received-files confirmation.
2. **Run view** (S4, S5) — current-status line + approval overlays + activity
   detail on demand.
3. **Deliverable view** (S7, S8, S9, S10) — document card with Open / Show /
   Preview, lineage chips, verification rail, mark-final / override. Built;
   polish continues (thumbnail, celebratory ready state after evidence clears).
4. **Sessions** (S6, S12) — resume and rerun.
5. **Settings** (S2, S13) — model / locality / workspace / tiers in buyer
   language (in-app sheet; onboarding remains a first-run window).

Explicitly cut from buyer surfaces: token internals beyond the memory bar,
tool chips as a default-open list, raw session IDs, developer tiers, GitHub/
MCP anything, "skills" as jargon (call them "workflow instructions" when they
surface at all). The words *terminal*, *.env*, *endpoint*, *API* never appear
on buyer surfaces.

## How this maps to build order

Remaining polish (not architecture): calm context summary line (S2),
celebratory deliverable card (S7), provider-swap runbook beat (S16), and
broader file-drop confirmation (S3). Evidence hard gate, fail-closed
sensitivity, consent default-on, keychain-only credentials, and the three
family demos are shipped.

## How screens get designed from this (what this document is NOT)

This document defines the moments and the cuts; it is deliberately not a
pixel spec. When a screen's cycle starts, write its **screen brief** as a new
subsection here (one page: purpose in one sentence, layout sketch, every
state — empty/loading/error/success, exact copy, and which stories'
acceptance moments it must satisfy), get it approved, then build. One
document, growing per cycle — no separate design docs. The retired
`docs/desktop-design.md` stub was deleted; this file is the single authority.

## Definition of "Apple-grade" for this product (so we stop hand-waving)

0. **North Star:** a business user always knows two things without looking
   for them — what the AI is seeing right now, and what it is doing right
   now. In a chat app the box is the product and transparency is a settings
   menu; in Quiver transparency is the product and the box is how you steer.
1. Every screen answers one question a persona actually has, above the fold,
   in their vocabulary. The words *terminal*, *.env*, *endpoint*, *API*
   never appear on buyer surfaces.
2. Zero dead elements: no "—", no empty bars, no counts of nothing, no
   buttons that exist because the plumbing does.
3. The dangerous moments (approvals) show content; the proud moments
   (deliverable) feel like receiving work; the trust moments (lineage) take
   two clicks or fewer.
4. Motion and copy are calm: no exclamation marks, no spinners without
   words, no jargon a partner wouldn't say aloud.
5. Verified visually, every release, against this document — not against a
   defect list.
6. **Light theme only** until a complete dark theme ships for every surface —
   a half-themed dark mode is worse than none.
