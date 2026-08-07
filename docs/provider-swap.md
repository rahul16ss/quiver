# Provider swap walkthrough (S16 — "never trapped")

The claim: if you switch model providers, nothing that matters moves. Memory,
sessions, skills, templates, workflows, and the audit trail are files on your
machine; the model is a rented calculator. This page is the boring-by-design
proof.

## What persists (files, not vendor state)

| Asset                  | Location                                          |
| ---------------------- | ------------------------------------------------- |
| Memory & persona       | `~/.quiver/` (global) + project `.quiver/memory/` |
| Sessions & checkpoints | project `.quiver/.sessions/` + `~/.quiver/*.db`   |
| Skills / instructions  | `~/.quiver/skills/`                               |
| Workflow packs         | `workflow-packs/` (your repo / pack files)        |
| Audit chain            | local hash-chained log                            |
| Evidence artifacts     | beside each deliverable (`*_Evidence.json`)       |
| Cost ledger            | `~/.quiver/cost-ledger.jsonl`                     |
| Routing evidence       | `~/.quiver/routing-evidence.json`                 |

## The swap

1. **Cloud → different cloud profile:** change `OPENROUTER_MODEL_PROFILE`
   (or the approved model in your engagement pack). No other change.
2. **Cloud → local/private:** set `LLM_API_BASE_URL` + `LLM_MODEL_NAME` +
   `LLM_API_KEY` to your local OpenAI-compatible endpoint and unset
   `OPENROUTER_API_KEY`. `buildProductionRuntime` selects the local route
   automatically; restricted/MNPI turns already refuse cloud.
3. **Verify the swap is boring:**
   - `quiver --version` then resume a previous session (`quiver --resume`) —
     the transcript, memory, and approvals are intact.
   - Re-run a reference demo (`npm run demo:ic-memo`) — deterministic, no
     network, so it passes identically before and after.
   - Start a workflow run — the same pack allowlist, sensitivity routing, and
     evidence gates apply; the run record now names the new route.

## What honestly changes

- **Capability coverage.** A profile that was never contract-tested for a
  MIME (PDF/DOCX/XLSX/PPTX) refuses native ingestion of that MIME until its
  contract test passes — the CapabilityRegistry fails closed rather than
  pretending the new model reads files it has not proven to read.
- **Cost/routing evidence.** Past spend stays in the cost ledger; routing
  evidence for the old profiles remains valid history, and you re-run
  `npm run eval:routing` to measure the new profiles.
- **Quality.** Re-run the acceptance checks for your engagement pack. The
  checks — not the vendor — decide whether the new model is good enough.

## What never happens silently

- No silent OCR/text-extraction fallback for native files.
- No silent cross-tier substitution (native-file messages never route to a
  text-only profile).
- No data leaves the configured boundary: sensitivity routing and the consent
  gate apply identically before and after the swap.
