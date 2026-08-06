# Model Router — Native-Document vs Text-Only Routing (ADR-001 §5)

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

| Profile slug | Model | Ctx | Intel | Code | Agent | $in/M | $out/M | Role |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `native-doc-frontier` | `anthropic/claude-opus-5` | 1M | 60.7 | 78 | 55.3 | $5 | $25 | reviewer / heavy doc analysis (charts, complex office deliverables) |
| `native-doc-primary` | `anthropic/claude-sonnet-5` | 1M | 53.4 | 71.5 | 46.7 | $2 | $10 | **default native-doc maker** |
| `native-doc-budget` | `google/gemini-3.6-flash` | 1.05M | 50.1 | 69.2 | 38.7 | $1.50 | $7.50 | high-volume native doc (file+video+audio) |

All three support tools + structured outputs + reasoning. Gemini Flash has
`reasoning.mandatory=true` (thinking cannot be disabled) — acceptable.

### Text-only tier (`input_modalities` = `["text"]`)

| Profile slug | Model | Ctx | Intel | Code | Agent | $in/M | $out/M | Role |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `text-failsafe` | `openai/gpt-5.6-sol` | 1.05M | 58.9 | 77.4 | 54 | $5 | $30 | failsafe (also native-file-capable — used for hard agentic+doc) |
| `text-checker` | `z-ai/glm-5.2` | 1M | 51.1 | 68.8 | 43.1 | $0.76 | $2.42 | **independent checker** (different family than maker) |
| `text-maker` | `deepseek/deepseek-v4-flash-0731` | 1M | 49.9 | 69.1 | 45.7 | $0.09 | $0.18 | **default text maker** (extreme value) |
| `text-pro` | `deepseek/deepseek-v4-pro` | 1M | 44.3 | 59.4 | 36.4 | $0.44 | $0.87 | heavier text reasoning fallback |

Maker/checker separation is preserved by family: the text maker is DeepSeek,
the checker is GLM (Z-Ai) — an independent failure mode, not the same weights
auditing themselves.

### Notes on what was *not* chosen
- **Mistral OCR / cloudflare-ai PDF engines are disallowed for Quiver.** They
  route the document through a third-party parser before the model. The only
  permitted PDF engine is `native` (ADR-001), which requires a file-capable
  model. The router fails closed — never silently substitutes OCR.
- **`openai/gpt-5.6-terra`** ($1/$6, intel 55, native file) is a strong
  budget-frontier option but is a limited-time discount model; not pinned in
  the default catalog for stability. A customer pack may add it.
- **Gemini 3.1 Pro / 2.5 Pro** have native file but lower agentic scores than
  the selected set.

## Routing rules

```
route(messages, role, sensitivity) -> profileSlug

1. restricted-mnpi            -> local-private-default (never cloud; ADR-001 §4.3)
2. native file part present   -> native-doc tier (fail closed if uncertified for that MIME)
     role=reviewer            -> native-doc-frontier  (claude-opus-5)
     role=maker | checker      -> native-doc-primary   (claude-sonnet-5)
     (fallback / budget)        -> native-doc-budget    (gemini-3.6-flash)
3. text-only                   -> text tier
     role=checker              -> text-checker         (glm-5.2)
     role=maker | planner      -> text-maker          (deepseek-v4-flash)
     role=reviewer             -> text-failsafe        (gpt-5.6-sol)
     role=failsafe             -> text-failsafe        (gpt-5.6-sol)
```

`modelProfile: "auto"` (the new default) invokes the router. An explicit
slug overrides — backward compatible with `OPENROUTER_MODEL_PROFILE`.

## Certification gate

Native ingestion still requires a passed contract test for the MIME
(`CapabilityRegistry`, §6). The router selects a *candidate* native-doc
profile; `QuiverOpenRouterClient.invoke` then re-checks `isCertifiedFor` and
fails closed if the profile is uncertified for that exact MIME — a PDF pass on
`claude-sonnet-5` does not authorize DOCX ingestion on the same profile.
