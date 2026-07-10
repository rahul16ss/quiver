# Quiver Desktop — Design Contract

> **Phase 0 — design before build.** This is the contract the desktop rebuild is
> measured against. It describes what a user *sees and does*, not the engine
> internals (those live in `docs/architecture.md`). Update this doc as the design
> hardens; do not let the implementation drift from it silently.
>
> **Implementation status:** the shipped app is a partial implementation of this
> contract — see `spec-quiver-harness.md` §19 (Epic 2) and
> `docs/qa/gui-qa-2026-07-10.md` for the current gap list. Where this document
> and reality differ, this is the target, not a claim.

## 0. North Star

A business user opens Quiver and always knows two things without looking for
them: **what the AI is seeing right now**, and **what the AI is doing right now**.
Everything else is in service of that. If a screen hides either, it is wrong.

This is the opposite of a chat app. In a chat app the box is the product and
transparency is a settings menu. In Quiver, transparency is the product and the
box is just how you steer it.

## 1. Non-negotiables

- **Mac and Windows**, one codebase (Electron). The engine and UX share one
  codebase; the only platform-specific work is packaging.
- **Branded Quiver**, Apache-2.0 forever. Built with Conviction's knowledge-work
  in mind, but never Conviction-branded. It is its own product.
- **Zero-config onboarding.** The words *terminal*, *.env*, *endpoint*, and
  *API* never appear to the user. The single key is stored in the OS keychain.
- **No rough edges:** calm when idle, perceptible when working, unmistakable
  when it needs you.
- **Plain language in the UI.** Internals are translated for the user:
  "tool_call" → "Quiver is editing a file"; "sandbox" → never shown;
  "context window" → "Quiver has used 40% of its memory this session."
- **Reversible by default.** Irreversible actions (delete, send externally)
  are loud and require a deliberate gesture, never a misclick.

## 2. The three always-on planes

The window is **not tabs**. Three planes are always visible.

### A. Context — *"What Quiver sees"* (left strip)
A calm, always-visible strip that shows the manifest before every turn:
- The model in use (one word + a small chip).
- Which memory files are loaded (persona, your preferences, workspace facts) —
  click any to open its editable card.
- Which skills are active (e.g. "Investment Brief v1") — click to read/edit.
- A context-usage bar in plain terms, colored gently as it fills.

This is the transparency-of-input principle made visible. The user never
wonders *"what did the AI see?"*

### B. Conversation — *"What you and Quiver are making"* (center)
The main area, but **not a chat log**. Quiver's replies are structured for
knowledge work:
- Findings carry inline citations; every claim links to its source.
- Draft deliverables appear as previewable cards (a report, a spreadsheet, a
  deck) — not a wall of markdown.
- Plans appear as checklists that fill in as it works.

You steer by typing, dropping in a file, or pasting an image. You are always one
message away from redirecting it.

### C. Activity — *"What Quiver is doing"* (right rail)
A live, readable stream — the audit chain, made human:
- "Searching the web: 'company X revenue 2025'"
- "Reading: annual-report.pdf"
- "Drafting: investment-brief.docx"
- "Verifying its work… ✓ 5 checks passed"

When Quiver is idle, the last verified outcome sits at the top. This is the
explainability plane: the user sees the *path*, not just the result. It is also
the compliance-ready audit trail — but it is never labeled "audit log" to the
user.

## 3. The moments that matter

### Onboarding (first launch)
- Detect Ollama automatically. If missing, one button: *"Set up the AI engine"*
  (no terminal, no paths).
- Ask for the single key. Store it in the OS keychain. Done.
- Pick the model for them (sensible default). Never ask for a model name.
- A 30-second guided first task (*"Research a company"*) so they feel the
  product, not a config screen.

### When Quiver wants to act — the approval gate
- Pause. Show a real before/after diff the user can read.
- One obvious primary action: **Allow**. One escape: **Suggest a change** (type
  a note; it goes back to the AI).
- *"Allow all similar this session"* is available but never the default.
- Irreversible actions get a red stripe and require typing a confirmation word.

### When Quiver verifies its work — self-heal
- Show *"Verifying its work…"* with what is being checked.
- On success: a calm *"✓ Verified"* with the criteria that passed.
- On failure: *"Found an issue — fixing…"* and the Activity rail shows the fix.
  Never silent, never a raw stack trace.

### When Quiver makes a document
- Inline preview: pages for Word, sheets for Excel, slides for PowerPoint.
- One button: **Open** (in their real Office app) and **Save to…**.
- Never make them leave Quiver to see what was made.

### Memory & Skills — *"what it remembers"*
- Plain-text files shown as editable cards — read, fix, delete. No folders,
  no JSON.
- A gentle **review queue** surfaces newly-learned facts: Accept / Edit /
  Reject. This is the *analyze → update* memory loop, made tangible.
- Skills show their version and can be reverted.

### Mid-run steering — you can interrupt
- While Quiver works, your typing is queued, not lost.
- **Esc** pauses; your message is injected so Quiver adjusts. **Stop** halts
  it cleanly. (Ctrl/Cmd+C is the hard stop, always available.)

## 4. Multi-modal — scope of this rebuild
- **Images:** drag in a chart, screenshot, or scanned page; Quiver sees it.
  Privacy is real: EXIF/metadata is stripped and the image is downscaled before
  it leaves the machine. This runs through `src/vision_router.ts` (the live
  agent's image path) and is runtime-verified by the acceptance gate
  (`VISION-ROUTER-EXIF-REDACTION`, `VISION-DOWNSCALE`).
- **Documents:** Word / Excel / PowerPoint created and previewed natively.
- **Video:** **out of scope** for this rebuild. The UI reserves an honest place
  for it (*"coming later"*) rather than shipping a broken button.

## 5. What this GUI must NOT be
- A generic chat clone. (The AionUi path. It made Quiver more like everything
  else, not less — and it hid the engine's transparency behind a chat box.)
- A developer tool in disguise. No terminal, no env files, no JSON in the UI.
- A set of tabs that hide transparency behind clicks.
- A product that claims a privacy feature it does not actually run.

## 6. How we'll know it's right
- A non-engineer can research a company and receive a cited brief with no help,
  on the first try.
- At any moment they can answer *"What is Quiver seeing?"* and *"What is Quiver
  doing?"* — by looking, not by asking.
- Nothing in the UI uses a word they would have to Google.
- The maker-checker, the audit trail, and memory review are felt as **calm
  trust** — not as features named in a menu.

## 7. Relationship to other docs (anti-redundancy)
- This doc = **what the user sees and does** (the UX contract).
- `docs/architecture.md` = **how the engine works** (internals).
- `docs/ICP.md` = **who it's for** (a pointer to `spec-quiver-harness.md` §1,
  the authoritative buyer definition).
- Do not duplicate engine internals here; reference them instead.