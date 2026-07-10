# Quiver — User Stories & Storyboard

**Status: DRAFT for owner review. No GUI development proceeds until these
stories are edited and approved by the owner.** This document owns the
"Solution + User stories" stage of the cycle (Problem+ICP → Solution+Stories →
Product+Marketing → Sales+CS). The technical spec (`spec-quiver-harness.md`)
owns architecture and status; this document owns *what it must feel like*.

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
- 🟡 Partial: six-layer context rail exists with honest endpoint line; it is
  read-only — the exclude-before-run gate does not exist (spec §6; build-order
  #5).
- Gap to Apple-grade: the rail reads like an inspector, not a sentence. The
  moment should be: one calm summary line ("Using your IC template, 2 memory
  files, 28 tools · prompts go to ollama.com") that expands on demand into
  items with exclude toggles. Priya scans it in 3 seconds; control is one
  click deep, not buried.

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
- 🟡 Partial: activity feed with timestamps exists (honest, log-like); Stop
  works; Esc-steering exists in the CLI path. Gaps: a single current-status
  line above the feed ("Reading RevenueBuild sheet… 3 of 6 sections
  drafted"); checker verification surfaced in plain language; queued-typing
  steering in the GUI.

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
  via officecli, template-driven (proven in the flagship example).
- Gap to Apple-grade: the card is functional, not celebratory. This is the
  product's money shot — it should feel like receiving work, not a download
  notification (document thumbnail/first-page preview, section count, and
  the flag count that leads Priya into Moment 5).

**S8. "The draft never bluffs."**
As Priya, every number in the draft is sourced or visibly flagged — the memo
tells me what it does NOT know (unresolved items) instead of papering over it.
- 🟡 Partial: fully real in the flagship example (evidence model + 8 checks,
  Excel cells verified by read-back); NOT yet generated live during GUI
  drafting. **This is build-order #3 and the single biggest product gap.**
- Acceptance moments: draft arrives with N sourced figures, M flagged; the
  checker literally refuses to call unsourced numbers done.

## Moment 5 — Verifying before signing (Marcus, Wednesday 9:40pm — the 90 seconds)

**S9. "Show me where the number came from."**
As Marcus, I click $48.2m and see the source in place: Model_v12.xlsx,
RevenueBuild, the cell, its value — without opening Excel. I click the
concentration claim and see the transcript excerpt. Two clicks, ten seconds.
- 🔴 Gap: exists on the website demo and in the generated evidence HTML;
  does NOT exist inside the GUI (no lineage chips, no verification rail).
  This is the §8.3 verification view — the moment the entire trust story
  exists for, and the demo climax for a buyer.

**S10. "My review is the record."**
As Marcus, I mark each key figure verified / flagged / needs-analyst; the memo
cannot be marked final while flags are open (an override is possible and
logged). My checks become the review record that goes with the memo.
- 🔴 Gap: review statuses exist in the evidence model; no GUI review flow.

**S11. "What was it fed?"**
As Marcus, in one click I see what informed this draft — files, sources,
excluded material, and where prompts went — so I can answer compliance
without a meeting.
- 🟡 Partial: context rail + run record artifact exist; a per-deliverable
  "context used for THIS document" view does not.

## Moment 6 — Running it again (Dana, next quarter)

**S12. "Rerun without ceremony."**
As Dana, I open last quarter's session, point at the new model file, and run
the same workflow; acceptance checks tell me it worked. If the model's
structure changed, Quiver halts and tells me what moved — it never silently
produces a wrong memo.
- 🟡 Partial: workflow.yaml + acceptance checks + rerun exist for the
  flagship example via CLI; no GUI "run this workflow again" affordance;
  drift detection not built (spec §12.4, deliberately Phase 2).

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
- 🟡 Partial: plain-file memory + review queue + GUI editing built; versioned
  persona/skills with diff/rollback and the episodic examples store are not
  (spec §7). The *ownership* is real today; the *compounding* is partial.
- Acceptance moments: Dana opens memory as normal files; edits survive and
  visibly shape the next run; promoting an example is one action.

**S15. "Sensitive deals stay inside the line."**
As Priya on a live deal, I mark the data room material sensitive; Quiver
shows me — before running — what would leave the machine and what stays
local, strips the names it was told to strip (and shows me the receipt), and
refuses to send configured MNPI to any remote endpoint. When compliance asks,
the run record answers.
- 🔴 Gap: honest endpoint disclosure and the run-record exist; redaction,
  sensitivity routing, and the receipt do NOT (spec §11.2, build-order #7 —
  scheduled before the first engagement touching sensitive material). Until
  built, the engagement-level answer is contractual/data-boundary docs, and
  no marketing may imply otherwise.
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
3. **Deliverable view** (S7, S8, S9, S10) — document card/preview with the
   evidence rail: figures list → source panels → verify/flag controls. *Does
   not fully exist yet; this is the next GUI cycle.*
4. **Sessions** (S6, S12) — resume and rerun.
5. **Settings** (S2, S13) — model/endpoint/workspace/tiers in buyer language.

Explicitly cut from buyer surfaces: token internals beyond the memory bar,
tool chips as a default-open list, raw session IDs, developer tiers, GitHub/
MCP anything, "skills" as jargon (call them "workflow instructions" when they
surface at all).

## How this maps to build order

Spec §19 build order, restated through stories: #3 live lineage = S8+S9,
#4 scratch-area tier = S4 depth, #5 consent-gate v1 = S2 (exclude-before-run)
+ S11, #6 connectors = S3 breadth, #7 redaction/routing = S15. Versioned
memory / examples store (spec §7) = S14 and queues behind first-engagement
evidence. S16 needs no new architecture — one provider-swap runbook page and
a demo beat. The next GUI cycle = Screen 3 (Deliverable view) designed from
S7–S10 *before* code.

## How screens get designed from this (what this document is NOT)

This document defines the moments and the cuts; it is deliberately not a
pixel spec. When a screen's cycle starts, write its **screen brief** as a new
subsection here (one page: purpose in one sentence, layout sketch, every
state — empty/loading/error/success, exact copy, and which stories'
acceptance moments it must satisfy), get it approved, then build. One
document, growing per cycle — no separate design docs. The retired
`docs/desktop-design.md` contract is absorbed here.

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
