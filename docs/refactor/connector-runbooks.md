# Connector Runbooks (refactor)

> **Historical snapshot.** This document records the production-refactor
> baseline and phased plan as of the audit/migration period. Current engineering
> status is **`NOTES/FINISH_LINE.md`** (HEAD `cbb0b67`, 2026-08-07): Electron /
> `ui/` / `npm run gui` / interactive `tui.ts` are removed; the buyer surface is
> the loopback browser UI (`src/harness/ui/`); OpenRouter is the sole shared cloud
> gateway; Parallel is the sole public-web research gateway; production callers
> share `buildProductionRuntime()`. Treat claims below as historical unless
> independently confirmed against current source.


> How a customer engagement wires data-vendor connectors, storage providers,
> model routes and research boundaries into a CustomerPack. Connectors are
> per-engagement; Quiver provides the framework, not the credentials.

## 1. Model routes (OpenRouter + local)

1. Obtain an OpenRouter API key (ZDR-eligible providers only).
2. Store the key in the OS credential store (`quiver` CLI: `quiver secrets set
   OPENROUTER_API_KEY`). Never put it in the pack or `.env` committed to git.
3. Add approved model profiles to the pack:
   ```json
   "approvedModels": [
     { "profileSlug": "text-planner", "roles": ["planner"], "providerOrder": ["OpenAI"] },
     { "profileSlug": "text-maker", "roles": ["maker"], "providerOrder": ["OpenAI"] },
     { "profileSlug": "text-checker", "roles": ["checker","reviewer"], "providerOrder": ["Google"] },
     { "profileSlug": "native-doc-primary", "roles": ["maker","reviewer"], "providerOrder": ["Anthropic"] },
     { "profileSlug": "native-doc-checker", "roles": ["checker"], "providerOrder": ["MoonshotAI"] }
   ]
   ```
4. Run the opt-in native-document contract tests
   (`QUIVER_LIVE_CONTRACT=1 OPENROUTER_API_KEY=… QUIVER_LIVE_PDF=… npx tsx
   tests/harness/live/run.ts`) to certify each profile for the MIME types the
   engagement needs. Uncertified MIME types fail closed at runtime.
5. For restricted/MNPI work, configure a `localPrivateRoute` in the pack and a
   `restricted-mnpi` sensitivity profile with `cloudInferenceAllowed: false`.
   The PolicyEngine fails closed if no local route is configured.

## 2. Public-web research (Parallel)

1. Obtain a Parallel API key; store it in the OS credential store
   (`PARALLEL_API_KEY`).
2. Declare the sensitivity profiles the engagement recognizes. For
   `confidential-internal`, set `parallelSanitizedOnly: true` so the
   ResearchGateway strips internal thesis/client identifiers before querying.
3. `restricted-mnpi` must have `parallelAllowed: false` — the pack validator
   rejects a pack that allows Parallel for MNPI.
4. Use `search` → select sources → `extract` for normal research; reserve
   `research` (Task) for genuinely broad multi-source synthesis. Use `monitor`
   for ongoing public signals.

## 3. Licensed data-vendor connectors

1. Implement a `DataConnector` (legacy `src/connectors/framework.ts`) or an
   `IntegrationBroker` integration declaring capabilities, auth scopes, data
   classification, read/write side effects, required approvals, licensed-data
   restrictions, rate limits and expected cost.
2. Entitle the connector in the pack:
   ```json
   "dataVendorEntitlements": [
     { "connector": "edgar", "datasets": ["filings-ir"], "redistributionAllowed": false, "cacheExpirySeconds": 3600 }
   ]
   ```
3. Resolve credentials with `resolveConnectorSecretSync(name)` (OS credential
   store first, env fallback). Quiver is not a data reseller.
4. Required source categories that have no entitled connector surface a
   substitution warning and are never silently satisfied by open-web research.

## 4. Storage providers

| Provider | When | Honest guarantees |
| :--- | :--- | :--- |
| `LocalStorageProvider` | Files on disk; or a synced OneDrive/SharePoint/Drive folder | Full versioning only when backed by a real VCS; a synced cloud folder is labelled **reduced-guarantee local mode** |
| `MicrosoftGraphStorageProvider` | SharePoint / OneDrive with cloud identity | ETag/version conflict detection, delta queries, upload sessions, fail-on-conflict (no `conflictBehavior:"replace"`) |
| `GoogleDriveStorageProvider` | Google Drive with OAuth | Stable file IDs, shared drives, revision metadata; re-fetch metadata before commit when conditional-overwrite safety cannot be guaranteed |

Refresh tokens live in the OS credential store, never `.env`. Office files are
never silently converted to/from Google-native formats; conversion is explicit
and warns about possible fidelity loss.

## 5. Office engine (OfficeCLI)

A specific audited OfficeCLI binary is bundled per platform, checksum-verified,
with background self-updates disabled. Macro-enabled, encrypted, IRM-protected
and sensitivity-labelled files are high-risk: read-only/copy-on-write by
default; macros are never executed. For high-stakes Excel deliverables, an
optional final native-Office review/recalculation gate is documented; OfficeCLI
is not Microsoft Office.

## 6. Diagnostics

`quiver` CLI (Phase 8) provides connector tests: model route reachability,
Parallel key validity, storage provider auth, OfficeCLI binary checksum. Run
`quiver diagnostics` after wiring a pack.