# Quiver — Ideal Customer Profile

*Built entirely from codebase evidence and market research. No prior assumptions.*

---

## 1. What Quiver Actually Is (From the Codebase)

Quiver is a **local-first, inspectable AI agent harness** — not a chatbot, not a coding assistant, not a wrapper around an API. The distinction matters:

| Capability | What It Means | Codebase Evidence |
|---|---|---|
| **Maker-Checker verification gate** | Before any high-risk write or destructive command, an isolated checker runs acceptance tests in a copy-on-write sandbox. The agent cannot approve its own work. | `src/subagents/checker.ts`, `src/subagents/checker_filter.ts`, `src/subagents/scratchpad_helpers.ts` |
| **Plain-text memory you own** | All memory is in editable `.txt` and `.json` files under `~/.quiver/`. No database, no embeddings, no opaque store. You can read, edit, version-control, or delete everything. | `~/.quiver/core.json`, `~/.quiver/projects/{name}/memory/` |
| **Context transparency manifests** | Before every model call, Quiver prints what enters the context: memory, skills, tools, model, token budget. The user never wonders "what did the AI see?" | `src/agent.ts` — `printContextManifest()` |
| **Audit chain** | Every action is logged in a hash-chained, tamper-evident audit trail. Secrets are redacted. Sessions are saved as JSON. | `src/logger.ts`, `src/session/` |
| **Model-agnostic by design** | Works with any OpenAI-compatible endpoint. Default is GLM-5.2 (open-weight, MIT-licensed). Vision fallback routes to Gemma 4 via Ollama. No vendor lock-in. | `src/providers/`, `src/adapters/`, `src/config.ts` |
| **Self-improvement loop** | The agent can propose updates to its own system prompt. The user reviews, edits, or rejects. It also mines past sessions for patterns. | `src/tools/prompt_update.ts`, `src/tools/continual_learning.ts` |
| **Security-first architecture** | Path sandboxing, command risk classification (safe → destructive), secret detection/redaction, read-before-write CAS (content-addressed storage), atomic writes with rollback. | `src/security/path_policy.ts`, `src/security/command_policy.ts`, `src/security/secrets.ts`, `src/session/file_access.ts`, `src/fs/atomic_write.ts` |
| **CLI + Desktop GUI** | Same engine, two surfaces. Terminal for power users, Electron app for visual workflows. Both share the same memory and sessions. | `src/cli.ts`, `ui/main.ts`, `ui/renderer/` |
| **28 tools, extensible at runtime** | File ops, web search, browser automation, deep research, entity discovery, GitHub integration, subagents, iterative loops. New tools can be created dynamically. | `src/tools/`, `src/registry.ts` |
| **Cloud sync (opt-in)** | Auto-detects Google Drive, OneDrive, Dropbox, iCloud. Syncs to `{cloud}/Quiver/`. No OAuth — just files in a folder. | `src/cloud_sync.ts` |

**The core thesis**: You own the harness, the memory, the audit trail, and the model choice. The agent is inspectable, not opaque. Verification is structural, not vibes-based.

---

## 2. Market Landscape (2026)

### The Shift That Created Quiver's Opportunity

Three converging forces in 2025-2026 created a market gap that Quiver fills:

### Force 1: Open-Weight Models Reached Frontier Parity

- **GLM-5.2** (Z.ai, MIT license): Near-frontier coding performance at 10-20% of proprietary API cost. 1M-token context. Self-hostable behind firewalls.
- **LongCat-2.0** (Meituan, MIT license): 1.6T parameters, 1M context, trained entirely on Chinese ASICs. Beat GPT-5.5 on SWE-Bench Pro.
- **Qwen3-Coder-Next** (Alibaba): 3B active parameters, 70%+ SWE-Bench Verified, 10-20× cheaper than frontier.
- **DeepSeek V4**: MIT-licensed, competitive on coding benchmarks.

**Implication**: The bottleneck is no longer "is the model good enough?" It's "can I trust, verify, and govern what the model does in my environment?" That's a harness problem, not a model problem.

### Force 2: Regulatory Pressure on AI-Generated Code

- **EU AI Act** (August 2, 2026 enforcement): Requires technical documentation, traceability, automatic logging, and human oversight for high-risk AI systems. Penalties: €15M or 3% of global turnover.
- **SOX, HIPAA, FFIEC, PCI DSS v4.0**: All updated in 2026 with AI audit trail requirements for finance, healthcare, and banking.
- **Article 50 transparency**: AI-generated content must be labeled and traceable.

**Implication**: Organizations need audit trails for AI actions. Not "we logged it to a database" — but hash-chained, verifiable, offline-checkable evidence. Quiver's AuditChain does exactly this.

### Force 3: Enterprise Flight from Closed APIs

- **Claude Fable 5 / Mythos 5 withdrawal**: US government ordered Anthropic to restrict access. Enterprises that built on Claude discovered their AI capability could disappear overnight.
- **GPT-5.6 access restrictions**: OpenAI forced to limit access per US government request.
- **Token bill shock**: Unbounded agent loops converting cloud budgets into "minor macroeconomic events" (per Saanya Ojha's analysis).
- **Data sovereignty**: Regulated industries can't send code/data to third-party APIs. Self-hosted open-weight models are the only compliant path.

**Implication**: Organizations want model independence. They want to switch models without re-platforming. They want to run behind their own firewall. Quiver's model-agnostic architecture directly addresses this.

### Competitive Landscape

| Tool | Type | Stars | Key Differentiator | Where Quiver Wins |
|---|---|---|---|---|
| **OpenCode** | Open-source coding agent | 179K | Massive community, polished TUI | Quiver has maker-checker verification, audit chain, context transparency manifests, plain-text memory governance |
| **oh-my-pi (omp)** | Coding agent with IDE integration | 15K | LSP/DAP integration, Rust core, hashline edits | Quiver has maker-checker, audit chain, self-improvement loop, model-agnostic design |
| **OpenDev** | Rust-native coding agent | 687 | Blazing fast (4.3ms startup), parallel agent fleets | Quiver has verification gate, memory governance, context transparency |
| **OpenGravity** | VS Code local AI agent | Small | 100% local, zero cloud, inline autocomplete | Quiver has maker-checker, audit trail, CLI+GUI, broader tool surface |
| **Claude Code** | Closed-source coding agent | N/A | Best-in-class model, polished UX | Quiver is open-source, model-agnostic, has audit trail, local-first |
| **Codex CLI** | Closed-source coding agent | N/A | OpenAI ecosystem integration | Quiver is open-source, model-agnostic, has verification gate |
| **MakerChecker** | AI agent governance layer | New | Segregation of duties, hash-chained audit | Quiver has this built-in, plus the full agent harness, tools, and memory system |

**The gap**: No single tool combines (1) local-first open-weight model support, (2) structural verification gates, (3) hash-chained audit trails, (4) plain-text editable memory, (5) context transparency manifests, and (6) CLI + GUI. Quiver is the only tool that has all six.

---

## 3. Ideal Customer Profile

### Primary ICP: Regulated Engineering Teams Running Open-Weight Models

**Who**: Engineering teams in regulated industries (finance, healthcare, government, defense, critical infrastructure) who have adopted or are adopting open-weight models (GLM-5.2, Qwen, DeepSeek, Llama) for software development and research, and need verifiable governance over AI-generated outputs.

**Firmographics**:
- **Industry**: Financial services, healthcare/pharma, government/defense, legal services, critical infrastructure
- **Size**: 50-500 engineers (small enough that tooling decisions are bottom-up, large enough that compliance is a real constraint)
- **Geography**: EU (EU AI Act enforcement), US (SOX/HIPAA regulated), UK, Singapore, Australia
- **Technical maturity**: Already running Ollama or self-hosted inference. Have a DevOps/Platform team. Use git. Have CI/CD.
- **Compliance posture**: Subject to SOX, HIPAA, GDPR, EU AI Act, FFIEC, PCI DSS, or ISO 27001

**Why they need Quiver specifically**:

1. **They can't use Claude Code or Copilot** — data can't leave their environment. Open-weight models self-hosted are their only option.
2. **They need audit trails for AI actions** — regulators will ask "who approved this AI-generated change?" Quiver's hash-chained AuditChain + maker-checker gate is the answer.
3. **They need to prove human oversight** — the EU AI Act Article 14 requires "effective human oversight." Quiver's approval gates and maker-checker system provide this structurally, not as a policy.
4. **They need model independence** — if their LLM provider gets restricted (as happened with Claude Fable 5 and GPT-5.6), they need to switch models without re-platforming. Quiver's model-agnostic design means swapping a config value.
5. **They need to manage AI context** — regulators require knowing what context was provided to the AI. Quiver's context transparency manifests are logged and reviewable.

### Secondary ICP: Non-Technical Knowledge Workers Using Open-Weight Models

**Who**: Analysts, researchers, consultants, legal professionals, investment managers, compliance officers, and other knowledge workers who use AI for research, analysis, and document production — and who, for privacy, cost, or compliance reasons, run open-weight models locally rather than using cloud-based AI services.

**Firmographics**:
- **Industry**: Financial services (investment banking, asset management, private equity), legal (law firms, in-house counsel), consulting (strategy, M&A, due diligence), healthcare (clinical research, pharma), policy/government
- **Size**: Solo practitioners to 500-person firms
- **Geography**: EU (EU AI Act compliance), US (SOX/HIPAA), UK, Singapore, Australia
- **Technical maturity**: Low to medium. They use tools, not build them. They need a GUI, not a terminal. They want to say "research this company" and get a cited brief, not configure API endpoints.
- **Motivation**: "I want AI to do the grindy research and drafting work — but I can't send client data to OpenAI, and I need to verify every claim it makes."

**Why they need Quiver specifically**:

1. **Local-first means client data stays local** — lawyers, investment analysts, and consultants handle confidential client data. They can't use ChatGPT, Claude, or Copilot because data goes to third parties. Quiver + Ollama runs entirely on their machine.
2. **Maker-checker means verified outputs** — a KYC analyst can't afford hallucinated sanctions check results. Quiver's maker-checker gate runs structural checks before writing final deliverables. The agent can't approve its own work.
3. **Audit trail means compliance-ready** — regulators ask "how was this AI-generated report produced?" Quiver's hash-chained audit trail shows every step: what context was provided, what sources were consulted, what the checker verified.
4. **Plain-text memory means institutional knowledge** — a consultant's "skills" (how we write a credit memo, what our house style is, what the compliance review checklist looks like) are stored as editable text files, not locked in a vendor's cloud. This is the "skills" pattern Anthropic popularized, but local and owned.
5. **Provenance enforcement** — the system prompt explicitly requires facts to come from provided context, not from training data. For a legal researcher, this is the difference between a real citation and a hallucinated case law reference.
6. **GUI-first** — the Electron app provides a visual interface. Knowledge workers don't need to learn a terminal.

**Jobs-to-be-done** (specific to this ICP):
- "Research a company and produce a 2-page investment brief with cited sources"
- "Review a batch of KYC documents and flag compliance issues"
- "Draft a credit memo following our firm's template and review standards"
- "Compile a competitive matrix from public sources"
- "Summarize regulatory filings and extract key compliance requirements"
- "Prepare a due diligence checklist for an M&A target"

**Market evidence**:
- OpenAI reported non-developer Codex adoption grew **137x** (individual) and **189x** (organizational) since August 2025, outpacing developer adoption. Legal, Finance, and Recruiting departments now use Codex as their primary AI tool.
- Anthropic launched 10 finance agent templates (May 2026) for analysts — pitchbooks, KYC screening, month-end close, earnings reviews. All target non-technical knowledge workers.
- NeoXam launched AI agents for investment operations (June 2026) with "a complete and reviewable record of every action taken, safeguards for human approval of decisions deemed sensitive, and the freedom to choose, and later switch, the underlying AI model."
- Provision.ai charges $299/agent/month for a research analyst agent. Kongah charges $9.99-29.99/month for governed agent orchestration. Both target non-technical knowledge workers.
- The universal pattern: **Skills + Connectors + Subagents + Human-in-the-loop + Audit trail**. Quiver has 4 of 5 (missing connectors/integrations).

### Tertiary ICP: Privacy-Sensitive Independent Developers and Small Teams

**Who**: Solo developers, small consultancies, and research teams who choose open-weight models for privacy, cost, or philosophical reasons, and want a professional-grade harness (not a toy).

**Firmographics**:
- **Size**: 1-10 people
- **Industry**: Any, but especially: independent security researchers, privacy advocates, open-source maintainers, academic researchers, investigative journalists
- **Technical maturity**: High. Run Ollama locally. Comfortable with CLI. Value transparency and control.
- **Motivation**: "I want to use AI without sending my code to a third party, and I want to understand exactly what the AI is doing."

**Why they need Quiver specifically**:

1. **Local-first by design** — no telemetry, no cloud dependency, no API key required (Ollama works offline).
2. **Inspectable memory** — plain text files, not a vector database. They can see and edit exactly what the AI knows.
3. **Self-improvement loop** — the agent learns from sessions and proposes prompt updates. They stay in control.
4. **Professional tool surface** — 28 tools including deep research, entity search, browser automation. Not a toy.
5. **Cost** — open-weight models are 5-10× cheaper than proprietary APIs. Quiver doesn't add cost on top.

### Quaternary ICP: AI Safety Researchers and Auditors

**Who**: Researchers studying AI agent behavior, safety, and governance. Auditors who need to verify AI system compliance. Standards bodies developing AI governance frameworks.

**Firmographics**:
- **Type**: Research labs, audit firms, standards organizations, government agencies (NIST, ENISA, BSI)
- **Size**: Any
- **Motivation**: "I need to observe, measure, and verify how AI agents make decisions."

**Why they need Quiver specifically**:

1. **Full observability** — context manifests, audit chain, session logs, lifecycle traces. Every decision is traceable.
2. **Maker-checker as a research subject** — the verification gate is itself a model for AI governance research.
3. **Plain-text memory as a study artifact** — memory files are human-readable and can be analyzed, compared, and version-controlled.
4. **Model-agnostic** — researchers can test different models against the same harness and compare behavior.
5. **Open-source** — the entire system is auditable. No black boxes.

---

## 4. Jobs-to-be-Done

### Job 1: "Govern AI-generated code changes with audit trails"
**Trigger**: Regulator asks "show me who approved this AI-generated change and what context was provided."
**Job**: Produce a verifiable audit trail showing the full chain: user prompt → model → tool calls → maker-checker verification → approval → result.
**How Quiver does it**: AuditChain (hash-chained logs), context manifests (logged before each model call), maker-checker gate (independent verification before writes), session logs (full JSON transcripts with secrets redacted).

### Job 2: "Run AI coding agents on open-weight models behind my firewall"
**Trigger**: Organization mandates that no code or data can leave the corporate network.
**Job**: Use a capable AI coding agent with a self-hosted open-weight model, with no cloud dependency.
**How Quiver does it**: Ollama integration (default), model-agnostic provider layer, no telemetry, no cloud calls (except opt-in Parallel.ai APIs for web research), local-first memory and sessions.

### Job 3: "Understand and control what context the AI is using"
**Trigger**: User suspects the AI is making decisions based on stale or incorrect context.
**Job**: Inspect exactly what memory, skills, tools, and system prompt the AI received, and edit them.
**How Quiver does it**: Context transparency manifests (printed before every model call), plain-text memory files (editable in any text editor), `/memory` command to view loaded memories, context panel in GUI.

### Job 4: "Verify AI-generated changes before they're committed"
**Trigger**: AI agent proposes a code change. User needs confidence it won't break things.
**Job**: Run an independent verification check before the change is applied.
**How Quiver does it**: Maker-checker gate — before any high-risk write, an isolated checker runs acceptance tests in a copy-on-write sandbox. The agent cannot approve its own work. Targeted checking runs only relevant tests (90% reduction from full suite).

### Job 5: "Switch models without re-platforming"
**Trigger**: Current model provider restricts access, raises prices, or goes offline.
**Job**: Change the underlying model with minimal configuration, keeping all memory, sessions, and tooling.
**How Quiver does it**: Model-agnostic provider layer. Change `LLM_MODEL_NAME` in `.env` or use `/model` command. All memory, sessions, tools, and skills are model-independent.

### Job 6: "Research and analyze with AI while maintaining provenance"
**Trigger**: User needs to produce a research report or analysis where every claim must be traceable to a source.
**Job**: Use AI to research, synthesize, and write — with every fact traceable to its source.
**How Quiver does it**: Deep research tool (multi-hop web research with citations), entity search (verified people/company lookup), web search with source URLs, provenance principle enforced in system prompt ("facts must come from provided context, not from training").

---

## 5. Why Quiver Wins (Unique Value Proposition)

### The "Inspectability Stack"

No competitor combines all six layers:

```
┌─────────────────────────────────────────────┐
│  6. Context Transparency Manifests          │  "What did the AI see?"
├─────────────────────────────────────────────┤
│  5. Plain-Text Editable Memory              │  "What does the AI remember?"
├─────────────────────────────────────────────┤
│  4. Hash-Chained Audit Trail                │  "What did the AI do?"
├─────────────────────────────────────────────┤
│  3. Maker-Checker Verification Gate         │  "Who verified the AI's work?"
├─────────────────────────────────────────────┤
│  2. Model-Agnostic Provider Layer           │  "Which model did the AI use?"
├─────────────────────────────────────────────┤
│  1. Local-First, No Telemetry               │  "Where did my data go?"
└─────────────────────────────────────────────┘
         Nowhere else. Only in Quiver.
```

### Competitive Moats

1. **Maker-checker is architecturally unique** — no other open-source coding agent has a structural verification gate where an independent checker runs acceptance tests before writes are committed. MakerChecker (sammysltd) exists as a governance layer, but it's a separate service, not built into the agent harness.

2. **Plain-text memory is philosophically unique** — every other tool uses either no persistent memory, a vector database (opaque), or cloud-hosted memory (not portable). Quiver's plain-text files are editable, version-controllable, and human-readable. This is a design choice, not a limitation.

3. **Context transparency is operationally unique** — printing what enters the model call before every prompt is not done by any other agent. Claude Code shows tool results; OpenCode shows streaming output. Neither shows the full context composition (memory + skills + tools + system prompt + token budget) before the call.

4. **Audit chain is compliance-grade** — hash-chained, tamper-evident, with secret redaction. This is the kind of audit trail that satisfies SOX, HIPAA, and EU AI Act requirements. No other coding agent has this.

5. **Self-improvement loop is evolutionarily unique** — the agent proposes prompt updates, the user approves. No other agent has this feedback loop built into its architecture.

---

## 6. Market Sizing

### Total Addressable Market (TAM)

The AI coding agent market is estimated at $2-5B in 2026, growing at 40-60% CAGR. The open-weight model serving market (Ollama, vLLM, llama.cpp) has ~5M active users globally.

**Quiver's TAM**: Developers and teams using open-weight models for coding/research who need governance, audit trails, or local-first operation. Estimated at 500K-1M developers globally.

### Serviceable Addressable Market (SAM)

Regulated engineering teams + privacy-sensitive developers + AI safety researchers who are already using or evaluating open-weight models:
- **Regulated engineering**: ~50K-100K teams globally (finance, healthcare, government, defense)
- **Privacy-sensitive developers**: ~200K-500K globally
- **AI safety researchers/auditors**: ~5K-10K globally
- **Total SAM**: ~255K-610K individuals

### Serviceable Obtainable Market (SOM)

Given Quiver's current maturity (v1.0.0, 28 tools, CLI+GUI, Apache 2.0), realistic 12-month obtainable market:
- **Year 1**: 1,000-5,000 active users (open-source adoption via GitHub, Homebrew, npm)
- **Year 2**: 10,000-25,000 active users (if enterprise adoption kicks in via compliance use case)
- **Year 3**: 50,000+ (if maker-checker + audit chain becomes a compliance standard)

---

## 7. Positioning Recommendations

### Positioning Statement

**For** engineering teams and knowledge workers who use open-weight AI models,
**Quiver** is the inspectable agent harness
**that** provides structural verification, hash-chained audit trails, and editable plain-text memory,
**unlike** Claude Code, OpenCode, or Copilot (which are opaque, cloud-dependent, or lack verification gates),
**because** Quiver was designed from the ground up for transparency, governance, and model independence.

### Key Messages by Audience

**For regulated engineering teams**:
> "Quiver is the only coding agent where an independent checker verifies every high-risk change before it's committed — and every action is logged in a hash-chained audit trail that satisfies EU AI Act, SOX, and HIPAA requirements."

**For privacy-sensitive developers**:
> "Quiver runs entirely on your machine with open-weight models. Your code, your memory, your audit trail — all in plain text files you control. No telemetry, no cloud dependency, no vendor lock-in."

**For AI safety researchers**:
> "Quiver is the only agent harness where you can see exactly what context entered every model call, inspect the verification gate's decisions, and read the agent's memory in plain text. It's a research instrument, not just a tool."

### What NOT to Position As

- ❌ "Another coding agent" — Quiver is a *harness*, not an assistant. The distinction is governance.
- ❌ "Open-source Copilot" — Copilot is autocomplete. Quiver is an autonomous agent with verification.
- ❌ "Cheaper Claude Code" — Price is not the differentiator. Inspectability and governance are.
- ❌ "For developers only" — Quiver works for research, analysis, and knowledge work, not just coding.

---

## 8. Go-to-Market Signals

### High-Intent Signals (prospect is ready)

1. Organization has adopted Ollama or self-hosted inference for coding
2. Compliance team has asked about AI-generated code audit trails
3. Team has been affected by a model access restriction (Claude Fable 5, GPT-5.6 withdrawal)
4. Organization is subject to EU AI Act, SOX, HIPAA, or PCI DSS v4.0
5. Team is evaluating open-weight models for cost reduction but worried about governance

### Medium-Intent Signals (prospect is exploring)

1. Team uses Copilot/Claude Code but is concerned about vendor lock-in
2. Organization has a "local-first" or "data sovereignty" policy
3. Team is experimenting with open-weight models but hasn't committed
4. Engineering leadership has been asked to "evaluate AI governance frameworks"

### Low-Intent Signals (prospect is early)

1. Developer is curious about local AI but hasn't tried it
2. Organization is aware of EU AI Act but hasn't started compliance work
3. Team uses cloud-based AI tools and has no current pain

---

## 9. Product Gaps to Address for ICP Fit

Based on the codebase audit and market research, these gaps must be closed to serve all ICP segments:

### For Non-Technical Knowledge Workers (Secondary ICP) — HIGHEST PRIORITY

These gaps block adoption by the fastest-growing AI agent user segment (non-developers grew 137-189x per OpenAI data):

| Gap | Priority | ICP Impact | Effort |
|---|---|---|---|
| **Non-code workspace templates** | Critical | Without pre-built `.quiver/acceptance.md` templates for research reports, investment memos, compliance reviews, and due diligence checklists, non-technical users have no way to define what "good output" looks like. The maker-checker gate is useless without acceptance criteria. | Small |
| **Skills library for knowledge work** | Critical | Anthropic's finance agents work because they ship with skills (how to write a credit memo, how to screen KYC). Quiver needs equivalent skills for: investment briefs, competitive matrices, regulatory summaries, legal research memos. | Medium |
| **GUI polish for non-technical users** | High | The Electron app must be the primary surface, not the CLI. Onboarding must be zero-config (auto-detect Ollama, pre-select model, skip terminal). Context panel must show editable memory and skills visually. | Medium |
| **Document output formats** | High | Knowledge workers need Word, PDF, and Excel outputs, not markdown files. The agent should produce deliverables in formats they can share with clients and colleagues. | Medium |
| **Source citation enforcement** | High | For legal and financial research, every claim must have a verifiable source URL. The deep_research and web_search tools already return citations — the system prompt should enforce inline citations in all research outputs. | Small |

### For Regulated Engineering Teams (Primary ICP)

| Gap | Priority | ICP Impact | Effort |
|---|---|---|---|
| **LSP integration** (like omp) | High | Developers expect IDE integration. Without it, Quiver is terminal-only. | Large |
| **Hashline edit format** (like omp) | Medium | Would eliminate "string not found" retry loops, improving edit success rate from ~60% to ~90%+ | Medium |
| **MCP support** | Medium | Model Context Protocol is becoming the standard for tool interoperability. Enterprises expect it. | Medium |
| **Enterprise SSO/audit export** | Medium | Regulated teams need to export audit chains to SIEM systems (Splunk, ELK). | Small |
| **Multi-agent coordination** | Low | Parallel agent fleets (like OpenDev) for large-scale tasks. Niche for now. | Large |

---

## 10. Summary

Quiver's ICP is not "every developer who uses AI." It's specifically:

**Engineering teams and knowledge workers who have chosen open-weight models for privacy, cost, or compliance reasons — and need structural governance over what the AI does.**

The market created this opportunity through four converging forces:
1. Open-weight models reached frontier parity (the model is no longer the bottleneck)
2. Regulators demanded AI audit trails (the governance gap is real and enforced)
3. Closed API providers proved unreliable (model independence is a business continuity requirement)
4. Non-technical knowledge workers became the fastest-growing AI agent user segment (OpenAI: 137-189x growth, outpacing developers)

Quiver's six-layer inspectability stack (local-first → model-agnostic → maker-checker → audit chain → plain-text memory → context transparency) is architecturally unique. No competitor has all six. This is the moat.

The path to adoption has two entry points:
- **Developers**: try Quiver for local-first coding with open-weight models, discover the governance features, and bring it to their compliance team.
- **Knowledge workers**: try Quiver for local-first research and analysis (no data leaves their machine), discover the maker-checker verification and audit trail, and bring it to their compliance team.

Both paths converge: the compliance team discovers the audit chain satisfies regulatory requirements. The organization standardizes on Quiver.

**One sentence**: Quiver is for people who want to use open-weight AI models with the same governance, auditability, and control they expect from any other enterprise system — whether they write code or write investment memos.