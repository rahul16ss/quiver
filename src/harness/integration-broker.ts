/**
 * IntegrationBroker — Phase 9 (ADR-008).
 *
 * Retains direct APIs and MCPs behind a narrow interface. Each integration
 * declares its contract (capabilities, auth/scopes, data classification, read/
 * write side effects, required approvals, licensed-data restrictions, rate
 * limits, expected cost, health/freshness). MCP output and tool descriptions
 * are treated as UNTRUSTED INPUT and their provenance is preserved.
 */

import type {
  IntegrationBroker,
  IntegrationDeclaration,
  Integration,
  IntegrationInvokeOpts,
  IntegrationResult,
  PolicyDecisionResult,
  PolicyCondition,
} from "./interfaces.js";
import { wrapUntrustedContent } from "../prompts/security.js";

export interface IntegrationHandler {
  declaration: IntegrationDeclaration;
  invoke(input: unknown, opts: IntegrationInvokeOpts): Promise<unknown>;
}

export class QuiverIntegrationBroker implements IntegrationBroker {
  private handlers = new Map<string, IntegrationHandler>();

  register(handler: IntegrationHandler): void {
    this.handlers.set(handler.declaration.name, handler);
  }

  list(): IntegrationDeclaration[] {
    return Array.from(this.handlers.values()).map((h) => h.declaration);
  }

  get(name: string): Integration | undefined {
    const h = this.handlers.get(name);
    if (!h) return undefined;
    return {
      declaration: h.declaration,
      invoke: (input, opts) => this.invoke(name, input, opts),
    };
  }

  /**
   * Policy decision (§9): returns permitted=true ONLY when every condition is
   * resolved. A non-empty conditions list with any unresolved item is NOT
   * permission — the caller must resolve each before invoke().
   */
  decide(name: string, opts: IntegrationInvokeOpts = {}): PolicyDecisionResult {
    const h = this.handlers.get(name);
    if (!h) return { permitted: false, conditions: [], reasons: [`integration '${name}' not registered`] };
    const decl = h.declaration;
    const conditions: PolicyCondition[] = [];
    const reasons: string[] = [];

    // Required approvals.
    if (decl.requiredApprovals.length > 0) {
      const supplied = new Set(opts.approvals ?? []);
      const missing = decl.requiredApprovals.filter((a) => !supplied.has(a));
      if (missing.length > 0) {
        conditions.push({ id: "approval-required", reason: `missing approvals: ${missing.join(", ")}`, resolved: false });
        reasons.push(`missing approvals: ${missing.join(", ")}`);
      }
    }

    // Data classification: restricted-MNPI may not flow through a public integration.
    const sensitivity = opts.sensitivity ?? decl.dataClassification;
    if (sensitivity === "restricted-mnpi" && decl.dataClassification === "public") {
      conditions.push({ id: "sensitivity-mismatch", reason: "restricted-mnpi may not flow through a public integration", resolved: false });
      reasons.push("restricted-mnpi may not flow through a public integration");
    }

    // Rights: if the integration declares rights, the caller must have the
    // 'llm-processing' right to send data to a model. (This is a static check
    // against the declaration; a deployment resolves it via entitlement config.)
    if (decl.rights && !decl.rights.rights.includes("llm-processing")) {
      conditions.push({ id: "entitlement-llm-processing", reason: "integration is not entitled for LLM processing", resolved: false });
      reasons.push("not entitled for LLM processing");
    }

    // Network zone: air-gapped/private-network must not permit public-internet integrations.
    if (decl.networkZone === "public-internet" && opts.executionContext) {
      const ctx = opts.executionContext;
      if (ctx.deploymentProfile !== "connected-zdr") {
        conditions.push({ id: "network-zone", reason: `integration requires public-internet but profile is ${ctx.deploymentProfile}`, resolved: false });
        reasons.push(`integration requires public-internet but profile is ${ctx.deploymentProfile}`);
      }
    }

    // Mark conditions the caller claims resolved.
    const claimed = new Set(opts.resolvedConditions ?? []);
    for (const c of conditions) if (claimed.has(c.id)) c.resolved = true;

    const allResolved = conditions.every((c) => c.resolved);
    return { permitted: allResolved, conditions, reasons };
  }

  async invoke(name: string, input: unknown, opts: IntegrationInvokeOpts = {}): Promise<IntegrationResult> {
    const h = this.handlers.get(name);
    if (!h) {
      return { ok: false, error: `integration '${name}' not registered`, provenance: { vendor: name, dataset: "", apiRef: "", timestamp: new Date().toISOString() } };
    }
    // §9: invoke() re-runs decide() and refuses if any condition is unresolved.
    // A caller that ignores decide()'s output still cannot invoke.
    const decision = this.decide(name, opts);
    if (!decision.permitted) {
      const open = decision.conditions.filter((c) => !c.resolved).map((c) => c.reason);
      return { ok: false, error: `policy denied: ${open.join("; ") || "unresolved conditions"}`, provenance: { vendor: name, dataset: "", apiRef: h.declaration.name, timestamp: new Date().toISOString() } };
    }
    const decl = h.declaration;
    try {
      // Timeout + output-size enforcement.
      const timeoutMs = decl.timeoutMs ?? opts.budget?.timeoutMs ?? 30_000;
      const maxBytes = decl.maxOutputBytes ?? Infinity;
      const data = await Promise.race([
        h.invoke(input, opts),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`integration '${name}' timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);
      // Output-size limit.
      const serialized = typeof data === "string" ? Buffer.byteLength(data) : Buffer.byteLength(JSON.stringify(data));
      if (serialized > maxBytes) {
        return { ok: false, error: `output exceeds maxOutputBytes (${serialized} > ${maxBytes})`, provenance: { vendor: name, dataset: decl.capabilities.join(","), apiRef: decl.name, timestamp: new Date().toISOString() } };
      }
      return {
        ok: true,
        data,
        provenance: {
          vendor: name,
          dataset: decl.capabilities.join(","),
          apiRef: decl.name,
          timestamp: new Date().toISOString(),
        },
        warnings: [],
      };
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message,
        provenance: { vendor: name, dataset: "", apiRef: decl.name, timestamp: new Date().toISOString() },
      };
    }
  }
}

// ─── MCP adapter ──────────────────────────────────────────────────────

/**
 * Wrap MCP tool output and tool descriptions as untrusted content before they
 * reach model context. Provenance (which MCP server produced the output) is
 * preserved on the result. MCP servers and their tool descriptions are never
 * trusted to carry instructions.
 */
export function wrapMcpOutput(serverName: string, output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return wrapUntrustedContent(text, `mcp:${serverName}`);
}

export function wrapMcpToolDescription(serverName: string, description: string): string {
  return wrapUntrustedContent(description, `mcp:${serverName}:tool-description`);
}

/**
 * Build an IntegrationHandler from an MCP server connection. The actual MCP
 * transport (stdio/HTTP/SSE) is provided by the caller; this wraps its outputs
 * as untrusted and preserves provenance.
 */
export function mcpIntegration(
  name: string,
  serverName: string,
  capabilities: string[],
  invoke: (input: unknown) => Promise<unknown>,
  opts: Partial<IntegrationDeclaration> = {},
): IntegrationHandler {
  return {
    declaration: {
      name,
      label: opts.label ?? `MCP: ${serverName}`,
      capabilities,
      authScopes: opts.authScopes ?? [],
      dataClassification: opts.dataClassification ?? "public",
      readWrite: opts.readWrite ?? "read",
      requiredApprovals: opts.requiredApprovals ?? [],
      licensedDataRestrictions: opts.licensedDataRestrictions ?? [],
      rateLimits: opts.rateLimits,
      expectedCostUsd: opts.expectedCostUsd,
      health: opts.health ?? "unknown",
      freshness: opts.freshness,
      rights: opts.rights,
      networkZone: opts.networkZone,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      redactFields: opts.redactFields,
      inputSchema: opts.inputSchema,
      outputSchema: opts.outputSchema,
    },
    async invoke(input) {
      const raw = await invoke(input);
      // MCP output is untrusted — return the wrapped form so downstream prompt
      // assembly never treats it as instructions. The caller (tool node) sees
      // the wrapped string and provenance is on the IntegrationResult.
      return wrapMcpOutput(serverName, raw);
    },
  };
}