# Model Router — Native-Document vs Text-Only Routing (ADR-001 §5)

> **Historical snapshot.** This document records the production-refactor
> baseline and phased plan as of the audit/migration period. Current engineering
> status is **`NOTES/FINISH_LINE.md`** (HEAD `cbb0b67`, 2026-08-07): Electron /
> `ui/` / `npm run gui` / interactive `tui.ts` are removed; the buyer surface is
> the loopback browser UI (`src/harness/ui/`); OpenRouter is the sole shared cloud
> gateway; Parallel is the sole public-web research gateway; production callers
> share `buildProductionRuntime()`. Treat claims below as historical unless
> independently confirmed against current source.


> Status: implemented. Research grounded in the live OpenRouter Models API
> (`/api/v1/models?...&zdr=true&sort=intelligence-high-to-low`), queried Aug 6 2026.
> All scores are Artificial Analysis indices (intelligence / coding / agentic),
> per 1M-token USD pricing, with ZDR endpoints only.

## Why a router

Quiver ingests capital-markets documents (PDFs, Office files, charts) and runs
long-horizon agentic workflows (research, tool use, document drafting). No
single model is Pareto-optimal across both:

- **Native document ingestion** (PDF/DOCX/XLSX/PPTX/images) requires a model
  whose `input_modalities` include `file`. OpenRouter forwards the file
  directly to such a model — **no third-party OCR cloud** (Mistral) ever sees
  the bytes. This is a hard security requirement for MNPI: a prospectus or an
  internal model deck may not be sent to a separate OCR vendor.
- **Text→text agentic work** (planning, tool use, research reasoning, drafting)
  is dominated by far cheaper models that do *not* accept file input. Using a
  frontier multimodal model for these steps wastes 30–250× the cost per token
  with no quality gain.

The router selects a profile **per invocation** based on whether the message
carries a native file content part, the role (maker / checker / planner /
reviewer), and the data sensitivity.

## Selection (ZDR endpoints, live data)

### Native-document tier (`input_modalities` ⊇ `file`)

| Profile slug | Model | Ctx | $in/M | $out/M | Role |
| --- | --- | ---: | ---: | ---: | --- |
| `native-doc-frontier` | `anthropic/claude-opus-5` | 1M | $5 | $25 | reviewer / failsafe / heavy doc analysis (charts, complex office deliverables) |
| `native-doc-primary` | `anthropic/claude-sonnet-5` | 1M | $2 | $10 | **default native-doc maker** (Anthropic) |
| `native-doc-checker` | `moonshotai/kimi-k3` | 1M | $3 | $15 | independent native-doc checker (Moonshot ≠ Anthropic maker) |
| `native-doc-budget` | `google/gemini-3.6-flash` | 1.05M | $1.50 | $7.50 | high-volume native doc (file+video+audio) |

All support tools + structured outputs + reasoning. `gemini-3.6-flash` and
`gemini-3.5-flash` have `reasoning.mandatory=true` (thinking cannot be
disabled) — acceptable. `kimi-k3` is text+image (not `file`), so as a
native-doc *checker* it audits a digest/rendered document rather than
ingesting the raw file — it never grades a document the Anthropic maker
looked at unmediated.

### Text-tier profiles

| Profile slug | Model | Ctx | $in/M | $out/M | Role |
| --- | --- | ---: | ---: | ---: | --- |
| `text-planner` | `openai/gpt-5.6-sol` | 1.05M | $5 | $30 | planner (both tiers; file-capable so a native-file plan never fails closed) |
| `text-failsafe` | `openai/gpt-5.6-sol` | 1.05M | $5 | $30 | failsafe / reviewer |
| `text-checker` | `google/gemini-3.5-flash` | 1M | $1.50 | $9 | independent text checker (Google ≠ OpenAI maker) |
| `text-maker` | `openai/gpt-5.6-luna` | 1.05M | $0.10 | $0.60 | **default text maker** (high-volume) |
| `text-pro` | `deepseek/deepseek-v4-pro` | 1M | $0.44 | $0.87 | heavier text fallback |

Maker/checker separation is preserved by family in BOTH tiers: text maker is
OpenAI (Luna), text checker is Google (Gemini Flash); native-doc maker is
Anthropic (Sonnet 5), native-doc checker is Moonshot (Kimi K3) — an
independent failure mode, never the same weights auditing themselves. The
planner is OpenAI (Sol) and never audits the maker.

### Notes on what was *not* chosen
- **Mistral OCR / cloudflare-ai PDF engines are disallowed for Quiver.** They
  route the document through a third-party parser before the model. The only
  permitted PDF engine is `native` (ADR-001), which requires a file-capable
  model. The router fails closed — never silently substitutes OCR.
- **`openai/gpt-5.6-terra`** ($1/$6, native file) is a strong budget-frontier
  option but is a limited-time discount model; not pinned in the default
  catalog for stability. A customer pack may add it.
- **Gemini 3.1 Pro / 2.5 Pro** have native file but lower agentic scores than
  the selected set.

## Routing rules

```
route(messages, role, sensitivity, hintMime?) -> profileSlug

1. restricted-mnpi            -> local-private-default (never cloud; ADR-001 §4.3)
2. native file part present   -> native-doc tier (fail closed if uncertified for that MIME)
     role=reviewer|failsafe    -> native-doc-frontier  (claude-opus-5)
     role=checker              -> native-doc-checker   (kimi-k3)
     role=planner              -> text-planner         (gpt-5.6-sol)
     role=maker                -> native-doc-primary   (claude-sonnet-5)
3. text-only / text hintMime   -> text tier
     role=checker              -> text-checker         (gemini-3.5-flash)
     role=planner              -> text-planner         (gpt-5.6-sol)
     role=reviewer|failsafe    -> text-failsafe        (gpt-5.6-sol)
     role=maker                -> text-maker           (gpt-5.6-luna)
```

`modelProfile: "auto"` (the new default) invokes the router. An explicit
slug overrides — backward compatible with `OPENROUTER_MODEL_PROFILE`.

## Maker / checker / planner separation (mirrors pi's runtime loop)

The goal-seeking engine routes three distinct roles (ADR-001 §5):

- **planner** — `planNode` uses `role: "planner"` to decompose the goal into
  steps and tags each with its acceptance item (`[dod:...]`). Routing goes to
  `text-planner` (Sol) in both tiers; planning is never done by the maker
  model.
- **maker** — produce steps call `role: "maker"` to WRITE the analytical
  deliverable (not just dispatch a tool), routed by the deliverable MIME
  (`hintMime`).
- **checker** — the per-step gate and `checkerNode` use `role: "checker"`
  (independent family: Gemini text / Kimi native-doc) so the maker never
  grades its own draft; rejections feed back to the maker bounded by
  `MAX_STEP_REJECTIONS`, then escalate to the planner for a bounded
  `MAX_PLAN_REVISIONS` plan revision.

## Multimodal vs text-only across the task spectrum

Quiver produces both document deliverables and text analysis, so it needs
BOTH native-document (multimodal) models AND text-only models. The router
chooses per task via the `hintMime` option:

- A native-document deliverable (`docx`/`pdf`/`pptx`/`xlsx`) passes its MIME as
  `hintMime` → routes to the native-doc tier even on a text-only prompt, so
  the maker benefits from native document understanding when producing a
  Word/Excel/PowerPoint/PDF deliverable.
- A text deliverable (`text/plain`, memos-as-body) or pure analysis stays on
  the text tier.
- `native-file` input (a document is READ, not just written) still routes to
  the native-doc tier via modality.

`ModelClient.invoke({ hintMime })` threads the hint to `ModalityRouter.route`.
This is the concrete realization of the need for both natively multimodal and
non-multimodal models across the task spectrum.

## Certification gate

Native ingestion still requires a passed contract test for the MIME
(`CapabilityRegistry`, §6). The router selects a *candidate* native-doc
profile; `QuiverOpenRouterClient.invoke` then re-checks `isCertifiedFor` and
fails closed if the profile is uncertified for that exact MIME — a PDF pass on
`claude-sonnet-5` does not authorize DOCX ingestion on the same profile.
