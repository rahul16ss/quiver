# Model Router — Native-Document vs Text-Only Routing (ADR-001 §5)

Native ingestion still requires a passed contract test for the MIME
(`CapabilityRegistry`, §6). The router selects a _candidate_ native-doc
profile; `QuiverOpenRouterClient.invoke` then re-checks `isCertifiedFor` and
fails closed if the profile is uncertified for that exact MIME — a PDF pass on
`claude-sonnet-5` does not authorize DOCX ingestion on the same profile.

## Measured (Pareto) routing — `src/harness/routing-eval.ts`

The static profile order above is the policy default, not measured economics.
The routing-eval harness turns routing into evidence:

- `src/harness/eval-tasks.ts` — versioned starter suite of synthetic
  capital-markets tasks (extraction / review / drafting / reconciliation;
  text + native-file modalities) with deterministic rubric predicates. No
  LLM-as-judge on the default path.
- `scripts/run_routing_eval.ts` (`npm run eval:routing`) — runs the suite per
  profile with explicit slugs, records quality / cost / latency, computes the
  Pareto frontier per (role, modality), and persists a versioned snapshot to
  `~/.quiver/routing-evidence.json`. Offline scripted-mock mode is the default;
  `QUIVER_LIVE_EVAL=1` uses the production OpenRouter client (costs money).
- `ModalityRouter` accepts a `preferMeasured` hook: when the snapshot covers a
  (role, modality) cell, its Pareto winner (quality ≥ 0.8, within 3× of the
  cheapest qualifying point) is preferred. No evidence → static order,
  unchanged. Measured routing is never consulted for `restricted-mnpi` — MNPI
  routing stays local/private.
- `buildProductionRuntime` wires the evidence store into the model client
  automatically; engagements extend the suite with their own task packs and
  re-run the eval to refresh evidence.
