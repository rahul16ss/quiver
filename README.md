# Quiver

> Open foundation for controlled, source-backed document workflows in finance.

Quiver provides an open-source engine for running source-backed, audit-logged document workflows. It connects approved context, source documents, model adapters, and Office document generation with human review gates.

For commercial engagements, custom workflow packs, and team training, see [Conviction Studio](https://convictionstudio.com).

---

## 1. What Quiver is

Quiver helps investment, advisory, and wealth management teams build inspection-ready deliverables in the Office formats they already use. Rather than relying on generic chat outputs, Quiver enforces:

- **Controlled context & approved inputs**: Workflows operate within declared file and data boundaries.
- **Inspectable evidence**: Important figures can be connected to Excel cell coordinates, document pages, sections or URLs—or flagged for review.
- **Native Office output**: Drafts land in Word (`.docx`), Excel (`.xlsx`), or PowerPoint (`.pptx`).
- **Reviewer-in-the-loop sign-off**: Output remains a draft until a human reviewer approves or flags items.

---

## 2. Reference workflows & Ambient AI Engine

Quiver features a full **Ambient Workflow Engine** (`quiver workflow`) supporting 12 sprint templates across 3 families:

| Family | Workflow Pack | Purpose & Deliverable |
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

Run any workflow pack on demand:
```bash
quiver workflow run investment-committee-memo
```
Or set up background schedules / file watchers:
```bash
quiver workflow schedule investment-committee-memo --cron "0 8 * * 1"
quiver workflow watch post-earnings-evidence-pack --dir ./inbox --pattern "*.pdf"
```

---

## 3. Quick start

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

## 4. Core principles

1. **Start with the deliverable**: Output lands natively in Word, Excel, or PowerPoint.
2. **Sources you can inspect**: Important claims can be connected to cells, pages, sections or URLs—or explicitly flagged for review.
3. **Reviewer-in-the-loop governance**: Drafts require human sign-off; overrides are recorded in a local audit chain.
4. **Data handling configured per engagement**: Model endpoints and privacy boundaries are explicitly set by the operator.
5. **Reproducible verification**: Workflow behavior is validated against explicit acceptance checks.

---

## 5. Data handling

Quiver does not bake in a model endpoint. The operator configures an OpenAI-compatible endpoint via `LLM_API_BASE_URL`. When a cloud endpoint is used, prompt and file content sent in a request reaches that provider. Local model endpoints are supported. A fully local configuration requires external research and remote connectors to be disabled or separately approved. Memory, sessions, documents, and the audit log live in files on your machine. There is no telemetry.

### Recommended finance-client deployment configuration

The repository documents a recommended hardened deployment posture for institutional engagements:

- **Enabled**: Approved file access, Office document tools, evidence tracking, review gates, local audit logging.
- **Disabled by default**: Arbitrary shell execution, unapproved tool servers, dynamic tool creation, automatic background cloud sync.

See [profiles/finance-client/README.md](profiles/finance-client/README.md) for detailed configuration guidance.

---

## 6. Capability summary & detailed documentation

| Capability | Summary |
| :--- | :--- |
| **Native Office Output** | Builds `.docx`, `.xlsx`, and `.pptx` matching house templates |
| **Evidence & Lineage** | Tracks quantitative claims down to cell coordinates in Excel |
| **Reviewer Sign-off** | Blocks mark-final status while open flags remain; logs overrides |
| **Data Handling** | Operator-configured endpoints; local models & zero telemetry supported |
| **Desktop App** | Electron GUI for chat, context inspection, and reviewer sign-off |
| **Reference Workflows** | Executable demo pipelines for dealmaking, research, and wealth |

For the complete technical feature matrix (compaction consent, episodic memory store, drift detection, DMS framework), see [docs/capabilities.md](docs/capabilities.md).

---

## 7. Development

```bash
# Type check
npx tsc --noEmit

# Run unit & spec tests
npm test

# Launch desktop app (development)
npm run gui
```

---

## 8. License

Apache-2.0. Operating foundation for Conviction Studio.
