/**
 * Cost ledger — per-engagement spend accounting (§P1).
 *
 * For a services business, model/research spend is unit economics, not
 * analytics. This ledger is the durable record:
 *
 *   - every model call appends an entry (run id, engagement, profile, role,
 *     tokens, provider-reported cost) to a JSONL log on the user's machine;
 *   - `spend(engagementId)` aggregates;
 *   - `checkBudget` enforces a cap BEFORE a call — over-budget is a hard,
 *     honest error, never a soft warning;
 *   - `estimate` projects spend from recorded per-profile averages so an
 *     operator can see a pre-run estimate.
 *
 * Content is never recorded — ids, slugs, token counts, and costs only.
 */

import * as fs from "fs";
import * as path from "path";

export interface CostEntry {
  at: string;
  engagementId: string;
  runId?: string;
  kind: "model" | "research" | "tool";
  profileSlug?: string;
  role?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd: number;
}

export interface BudgetVerdict {
  allowed: boolean;
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  reason?: string;
}

export class CostLedger {
  constructor(private filePath: string) {}

  /** Append one entry (durable, flush-per-write — a crash loses at most nothing). */
  record(entry: CostEntry): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Heal a torn tail (crash mid-write) so the new entry never merges onto a
    // partial line: if the file doesn't end with a newline, insert one first.
    try {
      if (fs.existsSync(this.filePath)) {
        const stat = fs.statSync(this.filePath);
        if (stat.size > 0) {
          const fd = fs.openSync(this.filePath, "r");
          const tail = Buffer.alloc(1);
          fs.readSync(fd, tail, 0, 1, stat.size - 1);
          fs.closeSync(fd);
          if (tail[0] !== 0x0a) fs.appendFileSync(this.filePath, "\n");
        }
      }
    } catch {
      // Best-effort tail healing; the append below still proceeds.
    }
    fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }

  /** All entries, tolerating a torn final line. */
  entries(): CostEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      return fs
        .readFileSync(this.filePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as CostEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is CostEntry => e !== null && typeof e.costUsd === "number");
    } catch {
      return [];
    }
  }

  /** Total spend for an engagement (default: everything). */
  spend(engagementId?: string): number {
    return this.entries()
      .filter((e) => !engagementId || e.engagementId === engagementId)
      .reduce((s, e) => s + e.costUsd, 0);
  }

  /** Spend broken down by role (planner/maker/checker/…) for an engagement. */
  spendByRole(engagementId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries()) {
      if (e.engagementId !== engagementId) continue;
      const role = e.role ?? e.kind;
      out[role] = (out[role] ?? 0) + e.costUsd;
    }
    return out;
  }

  /**
   * Hard budget gate. Over (or exactly at) the cap is a refusal with a
   * human-readable reason — the caller must surface it, not swallow it.
   */
  checkBudget(engagementId: string, capUsd: number): BudgetVerdict {
    const spent = this.spend(engagementId);
    const allowed = spent < capUsd;
    return {
      allowed,
      spentUsd: spent,
      capUsd,
      remainingUsd: Math.max(0, capUsd - spent),
      reason: allowed
        ? undefined
        : `Engagement '${engagementId}' has spent $${spent.toFixed(4)} of its $${capUsd.toFixed(2)} cap. Further model calls are refused until the cap is raised or a new engagement is started.`,
    };
  }

  /**
   * Pre-run estimate: average recorded cost per profile × planned call counts.
   * Profiles with no history contribute 0 and are listed as unknown so the
   * estimate is honest about its blind spots.
   */
  estimate(planned: Array<{ profileSlug: string; calls: number }>): {
    estimatedUsd: number;
    unknownProfiles: string[];
  } {
    const byProfile = new Map<string, { total: number; n: number }>();
    for (const e of this.entries()) {
      if (e.kind !== "model" || !e.profileSlug) continue;
      const agg = byProfile.get(e.profileSlug) ?? { total: 0, n: 0 };
      agg.total += e.costUsd;
      agg.n++;
      byProfile.set(e.profileSlug, agg);
    }
    let estimatedUsd = 0;
    const unknownProfiles: string[] = [];
    for (const p of planned) {
      const agg = byProfile.get(p.profileSlug);
      if (!agg || agg.n === 0) {
        unknownProfiles.push(p.profileSlug);
        continue;
      }
      estimatedUsd += (agg.total / agg.n) * p.calls;
    }
    return { estimatedUsd, unknownProfiles };
  }
}
