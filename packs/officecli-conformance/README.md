# OfficeCLI Conformance Corpus

A realistic-but-synthetic/sanitized corpus for testing that the pinned, bundled
OfficeCLI binary preserves what matters in analyst deliverables. **No real
client data.** Macros are never executed; macro-enabled/encrypted/IRM/
sensitivity-labelled files are high-risk, read-only/copy-on-write.

The corpus is described in [`corpus.json`](corpus.json). Each fixture declares:

- `mustPreserve` — what OfficeCLI must keep intact across read → edit working
  copy → validate → render → round trip (formulas, named ranges, hidden/
  protected sheets, charts, pivots, conditional formatting, external links,
  comments, tracked changes, fonts, themes, layouts, embedded objects, currency
  formats, number units, sign conventions).
- `mustSurface` — what must be reported honestly (e.g. workbook repair warnings).
- `highRisk` — macro-enabled/encrypted/IRM/DDE/external-link files get
  read-only/copy-on-write treatment; macros are never executed.

## Running

- **CI (mock runner):** `tests/harness/06-office-engine.test.ts` exercises the
  harness asking the binary for the right preservation signals without a real
  binary.
- **Live (pinned binary):** opt-in, requires the bundled OfficeCLI binary with a
  populated checksum in `src/harness/office-engine.ts` (`OFFICECLI_PINS`). Run
  with `QUIVER_LIVE_CONTRACT=1` and the OfficeCLI live suite (to be populated in
  `tests/harness/live/`).

## OfficeCLI is not Microsoft Office

For high-stakes Excel deliverables, an optional final native-Office review/
recalculation gate is documented in [docs/refactor/connector-runbooks.md](../../docs/refactor/connector-runbooks.md).
The remaining fidelity boundary is stated honestly in the deliverable's run
record.