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

  async invoke(name: string, input: unknown, opts: IntegrationInvokeOpts = {}): Promise<IntegrationResult> {
    const h = this.handlers.get(name);
    if (!h) {
      return { ok: false, error: `integration '${name}' not registered`, provenance: { vendor: name, dataset: "", apiRef: "", timestamp: new Date().toISOString() } };
    }
    const decl = h.declaration;
    // Required approvals: refuse if the caller didn't supply them.
    if (decl.requiredApprovals.length > 0) {
      const supplied = new Set(opts.approvals ?? []);
      const missing = decl.requiredApprovals.filter((a) => !supplied.has(a));
      if (missing.length > 0) {
        return { ok: false, error: `missing required approvals: ${missing.join(", ")}`, provenance: { vendor: name, dataset: "", apiRef: "", timestamp: new Date().toISOString() } };
      }
    }
    // Data classification: refuse a restricted-MNPI call on a public-classified
    // integration unless the caller explicitly overrides sensitivity.
    const sensitivity = opts.sensitivity ?? decl.dataClassification;
    if (sensitivity === "restricted-mnpi" && decl.dataClassification === "public") {
      return { ok: false, error: "restricted-mnpi data may not flow through a public-classified integration", provenance: { vendor: name, dataset: "", apiRef: "", timestamp: new Date().toISOString() } };
    }
    try {
      const data = await h.invoke(input, opts);
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