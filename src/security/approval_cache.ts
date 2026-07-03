/**
 * Scoped Approval Cache — US-6.4
 *
 * Lets the user approve an action "for this session" so repeated similar
 * actions don't re-prompt every call — the missing middle ground between
 * per-call prompts and global autonomy grants.
 *
 * Cache keys are coarse-grained by capability, not per-exact-instance:
 *   • run_command  → keyed by risk band (e.g. "moderate")
 *   • file writes  → keyed by (tool, workspace-relative directory)
 *   • other tools  → keyed by tool name
 *
 * Entries are session-scoped (no disk persistence) and optionally TTL-bounded.
 */

export type ApprovalScope = "once" | "session";

interface CacheEntry {
  grantedAt: number;
  expiresAt: number | null; // null = session-long
}

export interface ApprovalKey {
  toolName: string;
  riskBand?: string;
  dir?: string; // workspace-relative directory for file tools
}

function keyOf(k: ApprovalKey): string {
  if (k.toolName === "run_command" && k.riskBand) {
    return `run_command:${k.riskBand}`;
  }
  if (k.dir !== undefined) {
    return `${k.toolName}:dir:${k.dir}`;
  }
  return `${k.toolName}`;
}

export class ApprovalCache {
  private entries = new Map<string, CacheEntry>();
  private defaultTtlMs: number | null;

  constructor(defaultTtlMs: number | null = null) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /** Returns true if an unexpired session/ ttl approval exists for the key. */
  has(key: ApprovalKey): boolean {
    const k = keyOf(key);
    const e = this.entries.get(k);
    if (!e) return false;
    if (e.expiresAt !== null && Date.now() > e.expiresAt) {
      this.entries.delete(k);
      return false;
    }
    return true;
  }

  /** Record an approval. Scope "session" persists for the session; "once" is
   * not cached (the caller already consumed the single approval). */
  record(key: ApprovalKey, scope: ApprovalScope, ttlMs?: number): void {
    if (scope !== "session") return;
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.entries.set(keyOf(key), {
      grantedAt: Date.now(),
      expiresAt: ttl ? Date.now() + ttl : null,
    });
  }

  /** Clear all cached approvals (e.g. when the user downgrades a tier). */
  clear(): void {
    this.entries.clear();
  }

  /** Number of cached approvals (for status display). */
  size(): number {
    return this.entries.size;
  }

  /** Human-readable summary of cached approvals. */
  summary(): string[] {
    const out: string[] = [];
    for (const [k, e] of this.entries) {
      const exp =
        e.expiresAt !== null
          ? ` (expires ${new Date(e.expiresAt).toLocaleTimeString()})`
          : " (session)";
      out.push(`${k}${exp}`);
    }
    return out;
  }
}
