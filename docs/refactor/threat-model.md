# Threat Model & Data-Flow Diagram (refactor)

## Data-flow diagram

```
                                   EXPERIENCE PLANE
                                   ┌──────────────────────────────┐
   analyst/reviewer ── browser ──▶ │ daemon (loopback, per-install │
                                   │ secret, origin/CSRF, root     │
                                   │ grants) → browser UI + CLI    │
                                   └──────────────┬───────────────┘
                                                  │ approve / reject
                                   CONTROL PLANE  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ ExecutionEngine (LangGraph) ── GoalContract + GapLedger           │
   │   makePlan → runStep → runVerify → runChecker → runEvaluate →     │
   │   (human interrupt) → commit                                      │
   │   checkpoints: SqliteCheckpointSaver (durable, replaceable)       │
   │   PolicyEngine: sensitivity / source-category / entitlement       │
   │   PromptCompiler: 7 layers (safety→domain→pack→workflow→role→     │
   │                     goal→gap ledger)                              │
   └───────┬───────────────────────┬──────────────────────┬───────────┘
           │ KNOWLEDGE              │ WORK-PRODUCT         │
           ▼                        ▼                      ▼
   ┌──────────────────┐   ┌────────────────────┐  ┌─────────────────────┐
   │ ModelClient       │   │ ArtifactRepository │  │ OfficeEngine        │
   │  QuiverOpenRouter │   │  snapshot→working  │  │  pinned OfficeCLI   │
   │  (ZDR, deny, no   │   │  copy→candidate→   │  │  (checksum-verified)│
   │  fallback)        │   │  evidence→diff→    │  │  render→look→fix    │
   │  LocalModelClient │   │  approval→commit   │  │  high-risk COW      │
   │  (MNPI escape)    │   └─────────┬──────────┘  └─────────────────────┘
   │ ResearchGateway   │             │ commit
   │  Parallel (search/│             ▼
   │  extract/research/│   ┌────────────────────┐
   │  monitor)         │   │ StorageProvider     │
   │ IntegrationBroker │   │  Local / Graph /    │
   │  (APIs + MCP,     │   │  Google Drive       │
   │  untrusted input) │   │  (fail-on-conflict) │
   └──────────────────┘   └────────────────────┘

   TraceSink spans ALL planes (metadata only; prompts/docs/excerpts redacted).
   LangSmith is an explicit, redacted customer option — never default.
```

## Sensitivity boundaries

| Profile | ModelClient route | ResearchGateway | TraceSink |
| :--- | :--- | :--- | :--- |
| public | OpenRouter (ZDR) | Parallel | local OTel (redacted) |
| confidential-internal | OpenRouter (ZDR) | Parallel (sanitized queries only) | local OTel (redacted) |
| restricted-MNPI | LocalModelClient only (fail closed if none) | denied | local OTel (redacted) |

## Threat model

| Threat | Surface | Control | Test |
| :--- | :--- | :--- | :--- |
| Prompt injection (document/web/MCP) | untrusted content reaching model context | `wrapUntrustedContent`/`wrapUntrustedFile`; untrusted-content layer in PromptCompiler | `09-security-threats.test.ts` INJECT-*, MCP-UNTRUSTED-WRAPPED |
| SSRF | research/extract URLs | `isPrivateUrl` blocks loopback/private/metadata; redirect re-check | SSRF-LOOPBACK/PRIVATE/METADATA-BLOCKED |
| Malicious Office package | OfficeCLI reads | high-risk detection (macro/encrypted/IRM/DDE/external); read-only/copy-on-write; macros never executed | OFFICE-MACRO/IRM/DDE-FLAGGED |
| Zip bomb / repair-warning | OfficeCLI validate | validate surfaces errors honestly (never claims valid) | OFFICE-VALIDATE-FAIL-SURFACED (06) |
| DDE / external links | Office files | warning-marker high-risk detection | OFFICE-DDE-FLAGGED |
| Macros | Office files | macro-enabled extensions → high-risk, COW, never executed | OFFICE-MACRO-HIGHRISK |
| Path traversal | file tools, shell commands | root-enforcing path policy; command risk classification; workspace targeting | TRAVERSAL-COMMAND-RISKY, TRAVERSAL-TARGETS-OUTSIDE-WORKSPACE, LOCAL-ROOT-ENFORCED |
| Credential leakage | logs, traces, prompts | `detectSecrets`/`redactSecrets`; TraceSink redacts content keys; refresh tokens in OS credential store | CRED-DETECTED/REDACTED/TRACE-REDACTS-CONTENT |
| Browser downloads | browser control | browser control retained only for authenticated/interactive sites; never a hidden scraper fallback | RESEARCH-NO-REGEX-SCRAPER |
| MNPI egress to cloud | ModelClient / ResearchGateway | PolicyEngine fail-closed; restricted-mnpi → local route or deny; no OpenRouter fallback | POLICY-MNPI-MODEL-LOCAL-OR-FAIL, POLICY-MNPI-RESEARCH-DENIED, MODEL-MNPI-REFUSED-CLOUD |
| Licensed-data substitution | research/tools | source-category resolution surfaces missing categories; noSubstituteCategories per workflow | SCENARIO-*-CATCHES-SUBSTITUTION |
| Silent provider/parser/research fallback | model/research | no fallback; fail closed on uncertified MIME / Parallel unavailability | MODEL-PDF-FAIL-CLOSED-UNCERTIFIED, RESEARCH-MNPI-REFUSED |
| Storage conflict (silent overwrite) | storage commit | fail-on-conflict (no `conflictBehavior:replace`); Drive sibling output | LOCAL/GRAPH-CONFLICT-FAIL-CLOSED, DRIVE-CONFLICT-SIBLING-OUTPUT |
| Untrusted MCP tool descriptions | IntegrationBroker | wrapped as untrusted content; provenance preserved | MCP-UNTRUSTED-WRAPPED |
| Trace content exfiltration to SaaS | TraceSink | redacts content keys; LangSmith opt-in only | CRED-TRACE-REDACTS-CONTENT |

## Failure modes that must fail closed (verified)

- OpenRouter request missing ZDR / data_collection=deny / require_parameters → refused by `QuiverOpenRouterClient`.
- Native PDF/Office ingestion on an uncertified profile → refused (no OCR/text-extraction substitution).
- Parallel unavailable for restricted-MNPI → refused (no regex HTTP fallback).
- OfficeCLI binary checksum mismatch → refused.
- Storage commit without reviewer+approvalRef → refused.
- Graph/Drive commit on version/ETag conflict → refused (or sibling output for Drive).
- Checkpoint state must be deterministic (rowid ordering) so resumability never misreports an interrupt.