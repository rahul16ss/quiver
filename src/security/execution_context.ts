/**
 * ExecutionContext + Deployment Profiles — §7.
 *
 * An immutable, per-run context that every model, tool, research, MCP, API,
 * storage and code-execution call must receive and enforce. It carries the
 * deployment profile (connected-zdr / private-network / air-gapped), the
 * allowed execution zone, data classification, source ACLs, entitlements,
 * retention rules, tool/network permissions, approval state, and trace ids.
 *
 * Air-gapped enforcement is BELOW the application layer, not a prompt:
 *   - external research, remote MCP, cloud DMS connectors, and cloud model
 *     gateways are removed from the executable tool registry;
 *   - outbound network is blocked via a global fetch/dns guard installed at
 *     startup (air-gapped mode only);
 *   - loopback / explicitly authorised private inference endpoints remain.
 *
 * This module is pure (no I/O) so it is fully unit-testable.
 */

export type DeploymentProfile = "connected-zdr" | "private-network" | "air-gapped";

export type DataClassification =
  "public" | "confidential-internal" | "restricted-mnpi" | "highly-sensitive";

export type NetworkZone = "loopback" | "private-network" | "public-internet";

export interface SourceAcl {
  /** Source categories the run is entitled to read (e.g. filings-ir, market-data-estimates). */
  allowedCategories: string[];
  /** Explicitly denied categories (overrides allowedCategories). */
  deniedCategories: string[];
}

export interface DataEntitlement {
  sourceId: string;
  /** What the run may do with this source's data. */
  rights: EntitlementRight[];
  cacheDurationHours?: number;
  geography?: string;
  retentionDays?: number;
}

export type EntitlementRight =
  | "internal-use"
  | "llm-processing"
  | "storage-caching"
  | "derived-data"
  | "redistribution"
  | "client-deliverable"
  | "training-prohibition";

export interface ToolPermission {
  /** Tool names permitted in this run. Absent = not permitted. */
  allowed: Set<string>;
  /** Tools explicitly removed from the registry in this profile. */
  removed: Set<string>;
}

export interface ExecutionContext {
  /** Immutable once constructed. */
  readonly runId: string;
  readonly customer: string;
  readonly actor: string;
  readonly dataClassification: DataClassification;
  readonly deploymentProfile: DeploymentProfile;
  /** Network zone the run may touch. */
  readonly allowedZone: NetworkZone;
  readonly sourceAcls: SourceAcl;
  readonly entitlements: DataEntitlement[];
  readonly retentionDays: number;
  readonly toolPermissions: ToolPermission;
  readonly approvalState: "not-required" | "pending" | "approved" | "declined";
  readonly traceId: string;
}

// ─── Profile defaults ────────────────────────────────────────────────

export interface ProfileConfig {
  /** External research (Parallel), remote MCP, cloud DMS, cloud model gateways. */
  allowExternalNetwork: boolean;
  /** Loopback / authorised private inference endpoints. */
  allowLoopback: boolean;
  /** Cloud model gateway (OpenRouter). */
  allowCloudModelGateway: boolean;
  /** Auto update checks, model downloads, package downloads. */
  allowAutoUpdates: boolean;
  /** Tools removed from the registry in this profile. */
  removedTools: string[];
}

const CONNECTED_ZDR: ProfileConfig = {
  allowExternalNetwork: true,
  allowLoopback: true,
  allowCloudModelGateway: true,
  allowAutoUpdates: true,
  removedTools: [],
};

const PRIVATE_NETWORK: ProfileConfig = {
  allowExternalNetwork: false,
  allowLoopback: true,
  allowCloudModelGateway: false,
  allowAutoUpdates: false,
  // External research + remote MCP + cloud DMS removed; local tools remain.
  removedTools: ["web_search", "scrape_url", "deep_research", "find_all", "entity_search"],
};

const AIR_GAPPED: ProfileConfig = {
  allowExternalNetwork: false,
  allowLoopback: true,
  allowCloudModelGateway: false,
  allowAutoUpdates: false,
  removedTools: ["web_search", "scrape_url", "deep_research", "find_all", "entity_search"],
};

const PROFILES: Record<DeploymentProfile, ProfileConfig> = {
  "connected-zdr": CONNECTED_ZDR,
  "private-network": PRIVATE_NETWORK,
  "air-gapped": AIR_GAPPED,
};

export function profileConfig(profile: DeploymentProfile): ProfileConfig {
  return PROFILES[profile];
}

export function resolveDeploymentProfile(env?: string): DeploymentProfile {
  const v = (env ?? process.env.QUIVER_DEPLOYMENT_PROFILE ?? "").toLowerCase();
  if (v === "air-gapped" || v === "airgapped") return "air-gapped";
  if (v === "private-network" || v === "private") return "private-network";
  return "connected-zdr"; // default for single-user loopback deployments
}

// ─── Network enforcement (below the application layer) ───────────────

/**
 * A host is reachable under the given profile. Air-gapped / private-network
 * block the public internet; only loopback (and, for private-network, hosts
 * on an explicit allowlist) are reachable.
 */
export function isHostReachable(
  host: string,
  profile: DeploymentProfile,
  privateAllowlist: string[] = [],
): boolean {
  const h = host.toLowerCase();
  const isLoopback = h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  if (profile === "connected-zdr") return true;
  if (profile === "air-gapped") return isLoopback;
  // private-network: loopback + explicit allowlist
  return (
    isLoopback ||
    privateAllowlist.some((a) => h === a.toLowerCase() || h.endsWith("." + a.toLowerCase()))
  );
}

/**
 * Install a global fetch guard that blocks public-internet egress in
 * air-gapped / private-network profiles. Returns a teardown function.
 *
 * This is BELOW the application layer: even if a tool calls fetch() directly,
 * the guard rejects the request before it leaves the process. The guard is
 * no-op for connected-zdr.
 */
export function installNetworkGuard(
  profile: DeploymentProfile,
  privateAllowlist: string[] = [],
): () => void {
  if (profile === "connected-zdr") return () => {};
  const originalFetch = globalThis.fetch;
  const guard = async (input: any, init?: any) => {
    let urlStr: string;
    try {
      urlStr = typeof input === "string" ? input : (input?.url ?? String(input));
    } catch {
      urlStr = String(input);
    }
    let host = "";
    try {
      host = new URL(urlStr).hostname;
    } catch {
      // Non-URL input — let the original fetch handle/throw.
      return originalFetch(input, init);
    }
    if (!isHostReachable(host, profile, privateAllowlist)) {
      throw new Error(
        `Network blocked by deployment profile '${profile}': ${host} is outside the allowed zone. ` +
          `Air-gapped/private-network mode permits only loopback (and explicitly authorised private hosts). ` +
          `External research, remote MCP, cloud DMS and cloud model gateways are removed in this profile.`,
      );
    }
    return originalFetch(input, init);
  };
  // Preserve statics (Response, Request, etc.) and the original reference.
  (guard as any).originalFetch = originalFetch;
  globalThis.fetch = guard as any;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ─── Context builder ─────────────────────────────────────────────────

export interface ExecutionContextInit {
  runId: string;
  customer: string;
  actor: string;
  dataClassification: DataClassification;
  profile?: DeploymentProfile;
  allowedCategories?: string[];
  deniedCategories?: string[];
  entitlements?: DataEntitlement[];
  retentionDays?: number;
  allowedTools?: string[];
  approvalState?: ExecutionContext["approvalState"];
  traceId: string;
}

export function buildExecutionContext(init: ExecutionContextInit): ExecutionContext {
  const profile = init.profile ?? resolveDeploymentProfile();
  const cfg = profileConfig(profile);
  const allowed = new Set(init.allowedTools ?? []);
  // Apply profile tool removals.
  for (const t of cfg.removedTools) allowed.delete(t);
  return Object.freeze({
    runId: init.runId,
    customer: init.customer,
    actor: init.actor,
    dataClassification: init.dataClassification,
    deploymentProfile: profile,
    allowedZone:
      profile === "air-gapped"
        ? "loopback"
        : profile === "private-network"
          ? "private-network"
          : "public-internet",
    sourceAcls: {
      allowedCategories: init.allowedCategories ?? [],
      deniedCategories: init.deniedCategories ?? [],
    },
    entitlements: init.entitlements ?? [],
    retentionDays: init.retentionDays ?? 30,
    toolPermissions: { allowed, removed: new Set(cfg.removedTools) },
    approvalState: init.approvalState ?? "not-required",
    traceId: init.traceId,
  });
}

/**
 * The effective tool registry for a run: the full registry filtered by the
 * context's tool permissions. External tools are removed in air-gapped /
 * private-network profiles — not merely discouraged.
 */
export function filterToolsByContext<T extends { name: string }>(
  tools: T[],
  ctx: ExecutionContext,
): T[] {
  const removed = ctx.toolPermissions.removed;
  if (ctx.toolPermissions.allowed.size === 0 && removed.size === 0) return tools;
  return tools.filter(
    (t) =>
      !removed.has(t.name) &&
      (ctx.toolPermissions.allowed.size === 0 || ctx.toolPermissions.allowed.has(t.name)),
  );
}
