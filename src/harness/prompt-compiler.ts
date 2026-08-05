/**
 * PromptCompiler — Phase 1 scaffold (ADR-004).
 *
 * Compiles prompts from explicit layers:
 *   1. Runtime invariants and safety.
 *   2. Capital-markets domain policy.
 *   3. Customer pack.
 *   4. Workflow specification.
 *   5. Role prompt: planner / maker / checker / reviewer.
 *   6. Current goal and approved context.
 *   7. Current gap ledger and run state.
 *
 * This Phase 1 implementation provides the layer order, token estimation and
 * a customer-pack-bound compiler. The full capital-markets prompt *packs* are
 * Phase 5; here we provide the structure + the invariant safety layer so the
 * compiler is testable now and the assembler can delegate to it later.
 */

import type { PromptCompiler, PromptCompileInput, CompiledPrompt, CustomerPackRef, GapEntry } from "./interfaces.js";
import type { CustomerPack } from "./customer-pack.js";
import { SECURITY_PREAMBLE } from "../prompts/security.js";

const ROLE_PROMPTS: Record<PromptCompileInput["role"], string> = {
  planner: `You are a planner assistant for a capital-markets analyst. Build an explicit plan and gap ledger. Separate fact, derived value, assumption, interpretation and recommendation. Do not make autonomous portfolio decisions. Do not represent drafts as investment advice.`,
  maker: `You are a maker assistant for a capital-markets analyst. Produce the requested deliverable content. Every material figure must carry a source locator and a status (sourced / derived / assumed / unresolved / conflicting). Never invent sources.`,
  checker: `You are an independent checker. Verify tool success, deterministic assertions, evidence freshness and source coverage. Reject unsourced claims. A failed tool call, stale source, missing entitlement or invalid Office file is never a successful completion.`,
  reviewer: `You are a reviewer assistant. Summarize the change set, evidence and unresolved items honestly. Surface partial completion and limitations. Never mark a deliverable complete when mandatory evidence, validation or save-back failed.`,
};

export class QuiverPromptCompiler implements PromptCompiler {
  private readonly customerPack: CustomerPack;
  constructor(pack: CustomerPack) {
    this.customerPack = pack;
  }

  pack(): CustomerPackRef {
    return {
      id: this.customerPack.id,
      version: this.customerPack.version,
      summary: `${this.customerPack.label} (${this.customerPack.workflowSpecs.length} workflows, ${this.customerPack.approvedModels.length} approved models)`,
    };
  }

  compile(input: PromptCompileInput): CompiledPrompt {
    const layers: CompiledPrompt["layers"] = [];
    const parts: string[] = [];

    const push = (name: string, content: string | undefined, included: boolean) => {
      const tokenEstimate = included ? estimateTokens(content ?? "") : 0;
      layers.push({ name, included, tokenEstimate });
      if (included && content) parts.push(content);
    };

    // 1. Runtime invariants and safety.
    push("Runtime invariants & safety", SECURITY_PREAMBLE, true);

    // 2. Capital-markets domain policy.
    push(
      "Capital-markets domain policy",
      CAPITAL_MARKETS_DOMAIN_POLICY,
      true,
    );

    // 3. Customer pack.
    push("Customer pack", this.compilePackLayer(), true);

    // 4. Workflow specification.
    push(
      "Workflow specification",
      input.workflowSpecId ? `Workflow: ${input.workflowSpecId}` : undefined,
      !!input.workflowSpecId,
    );

    // 5. Role prompt.
    push("Role prompt", ROLE_PROMPTS[input.role], true);

    // 6. Current goal and approved context.
    const goal = input.goal
      ? `Goal: ${input.goal.objective}\nDefinition of done:\n${input.goal.definitionOfDone.map((d) => `- ${d}`).join("\n")}`
      : undefined;
    push("Goal & approved context", [goal, input.approvedContext].filter(Boolean).join("\n\n"), !!(goal || input.approvedContext));

    // 7. Gap ledger and run state.
    const gap = input.gapLedger && input.gapLedger.length > 0 ? formatGapLedger(input.gapLedger) : undefined;
    const run = input.runState ? `Run state: ${JSON.stringify(input.runState)}` : undefined;
    push("Gap ledger & run state", [gap, run].filter(Boolean).join("\n\n"), !!(gap || run));

    const systemPrompt = parts.join("\n\n---\n\n");
    return {
      version: "1",
      systemPrompt,
      layers,
      totalTokenEstimate: layers.reduce((s, l) => s + l.tokenEstimate, 0),
    };
  }

  private compilePackLayer(): string {
    const p = this.customerPack;
    const lines: string[] = [];
    lines.push(`Customer: ${p.label}`);
    if (Object.keys(p.terminology).length > 0) {
      lines.push("House terminology:");
      for (const [k, v] of Object.entries(p.terminology)) lines.push(`- ${k}: ${v}`);
    }
    if (p.style.voice) lines.push(`Voice: ${p.style.voice}`);
    if (p.style.bannedPhrases?.length) lines.push(`Banned phrases: ${p.style.bannedPhrases.join(", ")}`);
    if (p.sourcePrecedence.length > 0) {
      lines.push("Source precedence:");
      for (const sp of [...p.sourcePrecedence].sort((a, b) => b.rank - a.rank)) {
        lines.push(`- ${sp.category} (rank ${sp.rank})${sp.note ? ` — ${sp.note}` : ""}`);
      }
    }
    return lines.join("\n");
  }
}

function formatGapLedger(gaps: GapEntry[]): string {
  const lines = ["Gap ledger:"];
  for (const g of gaps) lines.push(`- [${g.status}] ${g.description}${g.blocker ? ` (blocked: ${g.blocker})` : ""}`);
  return lines.join("\n");
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token. Good enough for budget display.
  return Math.ceil(text.length / 4);
}



/**
 * Compile the customer-pack and capital-markets domain-policy layer strings
 * for injection into the legacy prompt assembler (ADR-004 seam). Used when a
 * CustomerPack is bound to an agent run so the legacy 9-section assembler gains
 * the customer-pack + domain-policy layers without losing its existing sections.
 */
export function compileCustomerPackLayers(pack: import("./customer-pack.js").CustomerPack): {
  customerPack: string;
  domainPolicy: string;
} {
  const compiler = new QuiverPromptCompiler(pack);
  // compilePackLayer is private; re-implement via a role-less compile and
  // slice the relevant layers.
  const compiled = compiler.compile({ role: "maker" });
  const cpLayer = compiled.layers.find((l) => l.name === "Customer pack");
  const dpLayer = compiled.layers.find((l) => l.name === "Capital-markets domain policy");
  return {
    customerPack: cpLayer?.included ? extractLayerContent(compiled.systemPrompt, "Customer pack") : "",
    domainPolicy: dpLayer?.included ? extractLayerContent(compiled.systemPrompt, "Capital-markets domain policy") : "",
  };
}

function extractLayerContent(systemPrompt: string, layerName: string): string {
  // Layers are joined by "\n\n---\n\n"; find the layer by its leading header.
  const parts = systemPrompt.split("\n\n---\n\n");
  // The customer-pack layer begins with "Customer:" and the domain-policy layer
  // begins with "Capital-markets domain policy:".
  const marker = layerName === "Customer pack" ? "Customer:" : "Capital-markets domain policy:";
  return parts.find((p) => p.startsWith(marker)) ?? "";
}

const CAPITAL_MARKETS_DOMAIN_POLICY = `Capital-markets domain policy:
- Separate fact, derived value, assumption, interpretation and recommendation.
- Every material figure carries: value, unit/currency, as-of date/fiscal period, source identity/locator, source category, retrieved-at, transformation, status, reviewer.
- Source categories: market-data-estimates, filings-ir, transcripts-events, portfolio-models-trackers, internal-research-notes, public-web-research. Do not substitute one for another without explicit warning and approval.
- Point-in-time semantics: record as-of timestamps; honor fiscal calendars, ticker changes, dual listings, share classes, corporate actions and restatements.
- Distinguish actual vs estimate vs guidance, and reported vs adjusted figures.
- Open-web research (Parallel) is never a silent substitute for consensus, estimates, market prices, portfolio holdings, risk data or licensed research.
- Quiver does not make autonomous portfolio decisions and does not represent drafts as investment advice.`;