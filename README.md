# Quiver

> Open foundation for controlled, source-backed document workflows in finance.

Quiver provides an open-source engine for running source-backed, audit-logged document workflows. It connects approved context, source documents, model adapters, and Office document generation with human review gates.

For commercial engagements, custom workflow packs, and team training, see [Conviction Studio](https://convictionstudio.com).

---

## 1. What Quiver is

Quiver helps investment, advisory, and wealth management teams build inspection-ready deliverables in the Office formats they already use. Rather than relying on generic chat outputs, Quiver enforces:

- **Controlled context & approved inputs**: Workflows operate within declared file and data boundaries.
- **Inspectable evidence**: Important figures link directly to source cell coordinates or filing pages.
- **Native Office output**: Drafts land in Word (`.docx`), Excel (`.xlsx`), or PowerPoint (`.pptx`).
- **Reviewer-in-the-loop sign-off**: Output remains a draft until a human reviewer approves or flags items.

---

## 2. Reference workflows

Quiver includes executable reference workflow pipelines across three families:

| Reference workflow | Output | Command |
| :--- | :--- | :--- |
| **Investment committee memo** | Native Word memo plus evidence and review artifacts | `npm run demo:ic-memo` |
| **Post-earnings evidence pack** | HTML evidence pack plus review artifacts | `npm run demo:post-earnings` |
| **Portfolio review pack** | HTML portfolio pack plus review artifacts | `npm run demo:portfolio-review` |

> **Note**: Project Alder (`demo:ic-memo`) is the most complete native-Office reference workflow. The Research and Wealth examples demonstrate the shared evidence, verification, and review pattern using synthetic fixtures.

### What Quiver demonstrates

- Controlled inputs and declared source boundaries
- Native document generation matching house templates
- Inspectable evidence trails connecting claims to source data
- Explicit unresolved items and risk escalation checklist
- Human reviewer sign-off and audit logging
- Reproducible automated acceptance checks

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
2. **Sources you can inspect**: Quantitative claims link to cell coordinates or page numbers.
3. **Reviewer-in-the-loop governance**: Drafts require human sign-off; overrides are recorded in a local audit chain.
4. **Data handling configured per engagement**: Model endpoints and privacy boundaries are explicitly set by the operator.
5. **Reproducible verification**: Workflow behavior is validated against explicit acceptance checks.

---

## 5. Data handling

Quiver does not bake in a model endpoint. The operator configures an OpenAI-compatible endpoint via `LLM_API_BASE_URL`. When a cloud endpoint is used, prompt and file content sent in a request reaches that provider. Local model endpoints are supported and can be configured where an engagement requires zero remote transmission. Memory, sessions, documents, and the audit log live in files on your machine. There is no telemetry.

### Recommended finance-client deployment configuration

For institutional deployments, Quiver supports a hardened operational posture:

- **Enabled**: Approved file access, Office document tools, evidence tracking, review gates, local audit logging.
- **Disabled by default**: Arbitrary shell execution, unapproved tool servers, dynamic tool creation, automatic background cloud sync.

See [profiles/finance-client/README.md](file:///Users/rahul/quiver/profiles/finance-client/README.md) for detailed configuration guidance.

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

For the complete technical feature matrix (compaction consent, episodic memory store, drift detection, DMS framework), see [docs/capabilities.md](file:///Users/rahul/quiver/docs/capabilities.md).

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
