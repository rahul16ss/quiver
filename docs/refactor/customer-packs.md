# Customer Pack Documentation (refactor)

A **CustomerPack** is data/configuration, not a code fork. It configures Quiver
around a client's existing process, templates, data entitlements, storage and
review rules. This document describes the shipped reference pack and how to
author, version, diff, export, import and roll back a pack.

## The shipped reference pack

[`packs/conviction-studio-default/pack.json`](../../packs/conviction-studio-default/pack.json)
is a complete, valid example. It demonstrates:

- **House terminology & style** — IC, VDR, MNPI, IPS, BPS, EV/EBITDA; an
  analytical voice; banned phrases ("guaranteed return", "sure thing"); USD/
  millions conventions.
- **Templates & examples** — paths to IC memo, diligence tracker and portfolio
  review templates, and a synthetic Project Alder example.
- **Source precedence** — filings-ir (90) > market-data-estimates (80) >
  transcripts-events (70) > portfolio-models-trackers (60) > internal-research-
  notes (50) > public-web-research (10). Open web is never a silent substitute
  for licensed data.
- **Approved models** — `text-planner` (planner, OpenAI),
  `text-maker` (maker, OpenAI), `text-checker` (checker/reviewer, Google),
  `native-doc-primary` (maker/reviewer, Anthropic),
  `native-doc-checker` (checker, Moonshot), and `local-private-default` (all
  roles, local) — each with an explicit provider order and no automatic router.
- **Sensitivity profiles** — public (Parallel + OpenRouter ZDR),
  confidential-internal (Parallel sanitized queries only + OpenRouter ZDR),
  restricted-mnpi (no Parallel, no cloud; fail-closed to the local route).
- **Storage connectors** — local workspace, SharePoint (Graph), Google Drive.
- **Data-vendor entitlements** — EDGAR (filings-ir, no redistribution, 24h
  cache) and Refinitiv (estimates + transcripts, redistributable, 15min cache).
- **Allowed tools & domains** — explicit allow-list.
- **Reviewer roles & approval thresholds** — analyst (single, no commit) →
  senior_analyst → vp (commit) → ic_member (committee, commit) → partner (dual,
  commit) → cio (committee, commit) → advisor (single, no commit).
- **Prompt modules** — domain-policy, evidence-policy, office-policy,
  review-policy (referenced by the PromptCompiler).
- **Workflow specs** — the twelve Conviction Studio reference scenarios.
- **Evaluation fixtures** — synthetic/public only.
- **Memory** — scoped by customer/team/user/project/workflow; 90-day retention;
  `autoPromote: false` (harvested memory is never auto-promoted without review).
- **Local/private route** — a `credentialRef` pointer to the OS credential store
  (never the key itself).

## Schema & validation

The schema is defined in [`src/harness/customer-pack.ts`](../../src/harness/customer-pack.ts).
`validateCustomerPack(pack)` fails closed on:

- missing required top-level keys
- `schemaVersion != 1`
- any secret-like key present anywhere (api_key, secret, password, token,
  privateKey, bearer, refreshToken, clientSecret). `*Ref`/`*Reference` keys are
  **allowed** — they are pointers to the OS credential store, not secrets.
- `memory.autoPromote === true`
- a `restricted-mnpi` profile that allows cloud inference without a local route,
  or that allows Parallel

## Versioning, diff, export, import, rollback

- **Hash:** `packHash(pack)` — deterministic content-addressed version.
- **Diff:** `diffPacks(before, after)` — structural diff by path.
- **Registry:** `CustomerPackRegistry` — `loadFromFile`, `exportPack` (JSON,
  never includes secrets), `versions(id)` (history), `rollback(id, hash)`.
- Packs never contain secrets. Credentials live in the OS credential store and
  are referenced by `credentialRef`.

## Binding the pack to the harness

```ts
import { CustomerPackRegistry, QuiverPromptCompiler, QuiverPolicyEngine } from "./src/harness/index.js";
const reg = new CustomerPackRegistry();
const { pack } = reg.loadFromFile("packs/conviction-studio-default/pack.json");
const compiler = new QuiverPromptCompiler(pack);
const policy = new QuiverPolicyEngine(pack);
```

The PolicyEngine enforces the pack's sensitivity profiles; the PromptCompiler
layers the pack's terminology, style, source precedence and prompt modules into
every system prompt.