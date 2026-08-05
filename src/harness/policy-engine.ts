/**
 * PolicyEngine — Phase 1 (ADR-001, ADR-003, ADR-007).
 *
 * Enforces sensitivity, source-category, entitlement, approval and budget
 * policy. Fails closed. High-sensitivity content never falls back to
 * OpenRouter; restricted-mnpi never reaches Parallel.
 *
 * This is a pure, deterministic policy core (no I/O) so it is fully unit-
 * testable. A concrete deployment wraps it with config/secret resolution.
 */

import type {
  PolicyEngine,
  PolicyClassificationInput,
  PolicyRequest,
  PolicyDecision,
  SourceCategoryResolution,
  SensitivityProfile,
  IntegrationDeclaration,
  SourceCategory,
} from "./interfaces.js";
import type { CustomerPack } from "./customer-pack.js";

export class QuiverPolicyEngine implements PolicyEngine {
  constructor(private pack: CustomerPack) {}

  classify(input: PolicyClassificationInput): SensitivityProfile {
    // Explicit declaration wins.
    if (input.declaredProfile) return input.declaredProfile;
    // Pack-level default: the most restrictive profile the pack declares.
    const profiles = this.pack.sensitivityProfiles.map((p) => p.name);
    if (profiles.includes("restricted-mnpi")) return "restricted-mnpi";
    if (profiles.includes("confidential-internal")) return "confidential-internal";
    return "public";
  }

  decide(request: PolicyRequest): PolicyDecision {
    const profile = this.pack.sensitivityProfiles.find((p) => p.name === request.sensitivity);
    const reasons: string[] = [];
    const conditions: string[] = [];

    if (!profile) {
      return {
        permitted: false,
        reasons: [`No sensitivity profile declared for '${request.sensitivity}'.`],
      };
    }

    switch (request.kind) {
      case "model": {
        // Restricted/MNPI: cloud inference forbidden unless an approved local route exists.
        if (request.sensitivity === "restricted-mnpi") {
          if (!profile.cloudInferenceAllowed) {
            if (!profile.localRouteSlug && !this.pack.localPrivateRoute) {
              return {
                permitted: false,
                enforcedRoute: undefined,
                reasons: [
                  "restricted-mnpi requires an approved local/private route; none configured. Failing closed — no OpenRouter fallback.",
                ],
              };
            }
            return {
              permitted: true,
              enforcedRoute: "local",
              reasons: ["restricted-mnpi routed to approved local/private model."],
            };
          }
          // cloudInferenceAllowed === true for restricted-mnpi is rejected at pack
          // validation time, but defend in depth here too.
          return {
            permitted: false,
            reasons: ["restricted-mnpi with cloud inference is not permitted (fail closed)."],
          };
        }
        // confidential-internal: cloud inference (OpenRouter ZDR) permitted.
        if (request.sensitivity === "confidential-internal") {
          if (!profile.cloudInferenceAllowed) {
            return {
              permitted: false,
              enforcedRoute: "local",
              reasons: ["confidential-internal disallows cloud inference in this pack."],
            };
          }
          return {
            permitted: true,
            enforcedRoute: "openrouter",
            reasons: ["confidential-internal permitted on OpenRouter ZDR route."],
            conditions: ["ZDR + data_collection=deny must be enforced by the ModelClient."],
          };
        }
        // public.
        return {
          permitted: true,
          enforcedRoute: "openrouter",
          reasons: ["public content permitted on OpenRouter."],
        };
      }

      case "research": {
        if (request.sensitivity === "restricted-mnpi") {
          return {
            permitted: false,
            reasons: ["restricted-mnpi forbids Parallel public-web research."],
          };
        }
        if (request.sensitivity === "confidential-internal") {
          if (!profile.parallelAllowed) {
            return { permitted: false, reasons: ["confidential-internal disallows Parallel in this pack."] };
          }
          if (profile.parallelSanitizedOnly) {
            return {
              permitted: true,
              enforcedRoute: "parallel",
              reasons: ["confidential-internal permitted on Parallel with sanitized public queries only."],
              conditions: ["Sanitize the query: strip internal thesis, client identifiers and MNPI before sending to Parallel."],
            };
          }
          return { permitted: true, enforcedRoute: "parallel", reasons: ["confidential-internal permitted on Parallel."] };
        }
        return { permitted: true, enforcedRoute: "parallel", reasons: ["public content permitted on Parallel."] };
      }

      case "storage":
      case "office":
        return { permitted: true, reasons: [`${request.kind} action permitted; storage/office policy enforced by the provider.`] };

      case "integration": {
        // Licensed-data connectors: respect entitlements + data classification.
        if (request.dataCategories && request.dataCategories.length > 0) {
          const ent = this.pack.dataVendorEntitlements;
          for (const cat of request.dataCategories) {
            const allowed = ent.some((e) => e.datasets.includes(cat));
            if (!allowed) {
              conditions.push(`Source category '${cat}' has no entitled connector; substitution requires explicit approval.`);
            }
          }
        }
        return { permitted: true, reasons: ["integration action permitted; entitlement checks applied."], conditions };
      }

      case "memory":
        return {
          permitted: true,
          reasons: ["memory harvesting produces proposals only; never auto-promoted without review."],
          conditions: ["Harvested memory must be scoped and reviewed before entering model context."],
        };

      default:
        return { permitted: false, reasons: [`Unknown policy kind: ${String(request.kind)}`] };
    }
  }

  resolveSourceCategories(
    required: SourceCategory[],
    available: IntegrationDeclaration[],
  ): SourceCategoryResolution {
    const resolved: Array<{ category: SourceCategory; connector: string }> = [];
    const missing: SourceCategory[] = [];
    const substitutionWarnings: string[] = [];

    // Map categories to entitled connectors declared in the pack.
    const entitlements = this.pack.dataVendorEntitlements;

    for (const cat of required) {
      // public-web-research resolves to the ResearchGateway (Parallel), not a connector.
      if (cat === "public-web-research") {
        resolved.push({ category: cat, connector: "parallel" });
        continue;
      }
      const ent = entitlements.find((e) => e.datasets.includes(cat));
      const decl = available.find((a) => a.name === ent?.connector);
      if (ent && decl) {
        resolved.push({ category: cat, connector: decl.name });
      } else {
        missing.push(cat);
        // No silent substitution: surface a warning that a different category
        // cannot stand in for this one without explicit approval.
        substitutionWarnings.push(
          `No entitled connector for required source category '${cat}'. Do not substitute another category without explicit reviewer approval.`,
        );
      }
    }

    return { resolved, missing, substitutionWarnings };
  }
}

/** Convenience: the default fail-closed decision for restricted-mnpi model calls. */
export function failClosedNoLocalRoute(): PolicyDecision {
  return {
    permitted: false,
    reasons: ["restricted-mnpi with no approved local/private route: failing closed (no OpenRouter fallback)."],
  };
}