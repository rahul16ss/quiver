# Quiver

> Open foundation for controlled, source-backed document workflows in finance.

Quiver provides an open-source engine for running source-backed, audit-logged document workflows. It connects approved context, source documents, model adapters, and Office document generation with human review gates.

For commercial engagements, custom workflow packs, and team training, see [Conviction Studio](https://convictionstudio.com).

> **Harness status (2026-08-07, `cbb0b67`).** Production composition root
> (`buildProductionRuntime`) unifies browser UI, CLI, and daemon. **OpenRouter**
> is the sole shared cloud model gateway (ZDR prefs per request when used);
> **Parallel** is the sole public-web research gateway; Electron / `npm run gui`
> / `ui/` are removed — the buyer surface is the loopback browser UI under
> `src/harness/ui/`. Remaining external/deferred work (live MIME certs, live
> Graph/Drive, OfficeCLI checksum pins, scaffold packs → demo-ready Office,
> visual walkthrough) is listed in [NOTES/FINISH_LINE.md](NOTES/FINISH_LINE.md).
> Historical refactor ADRs live under [docs/refactor/](docs/refactor/).

---

## 1. What Quiver is

Quiver helps investment, advisory, and wealth management teams build inspection-ready deliverables in the Office formats they already use. Rather than relying on generic chat outputs, Quiver enforces:

- **Controlled context & approved inputs**: Workflows operate within declared file and data boundaries.
- **Inspectable evidence**: Important figures can be connected to Excel cell coordinates, document pages, sections or URLs—or flagged for review.
- **Native Office output**: Drafts land in Word (`.docx`), Excel (`.xlsx`), or PowerPoint (`.pptx`).
- **Reviewer-in-the-loop sign-off**: Output remains a draft until a human reviewer approves or flags items; finance-client sign-off also requires a valid companion evidence file.

---

## 2. Reference workflows & pack library

Quiver includes an **Ambient Workflow Engine** (`quiver workflow`) and **13** declared pack manifests across 3 families:

| Family | Workflow Pack | Intended purpose and deliverable |
| :--- | :--- | :--- |
| **Dealmaking** | `investment-committee-memo` | First-pass IC Memo (`.docx`) with registered cell lineage |
| **Dealmaking** | `diligence-tracker` | VDR document tracking & red flag matrix (`.xlsx`) |
| **Dealmaking** | `market-map` | Industry landscape, unit economics & multiples (`.pptx`) |
| **Dealmaking** | `pitchbook-materials` | Institutional pitch deck & credentials (`.pptx`) |
| **Research** | `post-earnings-evidence-pack` | Reported metrics, consensus deltas & transcript analysis (`.html`) |
| **Research** | `transcript-review` | Guidance shifts, tone analysis & non-GAAP checks (`.docx`) |
| **Research** | `thesis-tracker` | Long/short thesis tracking & KPI catalyst scoring (`.xlsx`) |
| **Research** | `company-primer` | Comprehensive equity research initiation primer (`.docx`) |
| **Wealth** | `portfolio-review-pack` | Asset allocation, performance & risk review (`.xlsx`) |
| **Wealth** | `investment-proposal` | HNW client portfolio proposal & tax profile (`.docx`) |
| **Wealth** | `manager-research-note` | Fund manager due diligence & style drift audit (`.docx`) |
| **Wealth** | `client-commentary` | Tailored quarterly client market update (`.docx`) |
| **Wealth** | `risk-exposure-summary` | VaR, factor exposure & stress testing summary (`.pdf`) |

Pack maturity is explicit. `investment-committee-memo`, `post-earnings-evidence-pack`,
and `portfolio-review-pack` are the three credential-free, runnable reference demos.
The other **ten** entries are `scaffold` packs: they provide a declared workflow,
sample inputs, and acceptance intent, but are not marketed as production-ready
document generators until they have their own runnable demo and acceptance gate.
Scaffold packs may name intended formats (including `.pdf`) that the current
`office_doc` tool does not yet emit — treat those as templates, not runnable
pipelines.

Run any workflow pack on demand (requires configured model; one-shot CLI):
```bash
quiver workflow list
quiver workflow run investment-committee-memo
```
For recurring/file-triggered automation, register a schedule or watch rule and
keep an interactive `quiver` session (or the daemon) running — one-shot
`quiver workflow schedule|watch` registers the rule then exits.

---

## 3. Installation

Quiver is developed on macOS and supports Windows as the primary customer
platform. Linux is not a supported customer target.

- **macOS:** install Node.js, run `npm ci`, and install OfficeCLI using its
  official installer.
- **Windows:** install Node.js, run `npm ci`, and install the official
  `officecli-win-x64.exe` or `officecli-win-arm64.exe` distribution (PowerShell
  installer or Scoop). If OfficeCLI is not on `PATH`, set
  `QUIVER_OFFICECLI_PATH` to its full path.
- Run `quiver init` once. It prefers the macOS Keychain or Windows Credential
  Manager for the model key and checks whether OfficeCLI is available.

---

## 4. Quick start

```bash
# Clone repository
git clone https://github.com/rahul16ss/quiver.git
cd quiver

# Install dependencies
npm install

# Run the spec acceptance suite
npm test

# Run reference workflow demonstrations
npm run demo:ic-memo
npm run demo:post-earnings
npm run demo:portfolio-review
```

---

## 5. Core principles

1. **Start with the deliverable**: Output lands natively in Word, Excel, or PowerPoint.
2. **Sources you can inspect**: Important claims can be connected to Excel cells or to file, page, section, or URL evidence—or explicitly flagged for review.
3. **Reviewer-in-the-loop governance**: Drafts require human sign-off; overrides are recorded in a local audit chain.
4. **Data handling configured per engagement**: Model endpoints and privacy boundaries are explicitly set by the operator.
5. **Reproducible verification**: Workflow behavior is validated against explicit acceptance checks.

---

## 6. Data handling

Quiver does not bake in a model endpoint. OpenRouter is the sole cloud model gateway (ADR-001); the operator configures it via `OPENROUTER_API_KEY` plus a certified model profile. A local/private OpenAI-compatible endpoint via `LLM_API_BASE_URL` is the high-sensitivity escape hatch. When a cloud endpoint is used, prompt and file content sent in a request reaches that provider (with ZDR / data_collection=deny enforced). Local model endpoints are supported. A fully local configuration requires external research and remote connectors to be disabled or separately approved. Memory, sessions, documents, and the audit log live in files on your machine. There is no product telemetry.

### Recommended finance-client deployment configuration

The repository documents a recommended hardened deployment posture for institutional engagements:

- **Enabled**: Approved file access, Office document tools, evidence tracking, review gates, local audit logging.
- **Disabled by default**: Arbitrary shell execution, unapproved tool servers.
- **Removed**: Dynamic tool creation, automatic background cloud sync.

See [profiles/finance-client/README.md](profiles/finance-client/README.md) for detailed configuration guidance.

---

## 7. Capability summary & detailed documentation

| Capability | Summary |
| :--- | :--- |
| **Native Office Output** | Builds `.docx`, `.xlsx`, and `.pptx` around configured templates |
| **Evidence & Lineage** | Tracks Excel-sourced figures to cell coordinates; other evidence remains file/page/section/URL scoped |
| **Reviewer Sign-off** | Blocks mark-final status while open flags remain; logs overrides |
| **Data Handling** | Operator-configured endpoints; local models supported; no product telemetry |
| **Browser UI** | Responsive browser app served by the loopback daemon (no Electron): workflow select, live progress, change-set approval, commit |
| **Reference Workflows** | Executable demo pipelines for dealmaking, research, and wealth |

For the governing principles, see [docs/principles.md](docs/principles.md). For the complete technical feature matrix (compaction consent, episodic memory store, drift detection, DMS framework), see [docs/capabilities.md](docs/capabilities.md).

---

## 8. Development

```bash
# Type check
npx tsc --noEmit

# Run unit & spec tests
npm test

# Launch the loopback browser UI (production composition root)
npm start
# or: npm run harness
```

---

## 9. License

Apache-2.0. Operating foundation for Conviction Studio.
