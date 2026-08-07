/**
 * Capital-markets domain types — Phase 9 (ADR-007).
 *
 * Explicit source categories, domain-normalization types/checks, and the
 * MaterialClaim record every material figure/claim must carry. Point-in-time
 * financial semantics, source precedence, and contradiction handling are
 * first-class. No substitution of one source category for another without an
 * explicit warning and approval.
 */

import type { SourceCategory, SensitivityProfile } from "./interfaces.js";

// ─── Source categories (re-exported for domain convenience) ───────────

export type { SourceCategory } from "./interfaces.js";

// ─── Issuer / security identity ───────────────────────────────────────

export interface SecurityIdentity {
  /** Stable canonical issuer id (e.g. LEI or a customer-resolved id). */
  issuerId: string;
  issuerName: string;
  /** Primary ticker + exchange. */
  ticker: string;
  exchange: string;
  /** Ticker changes, dual listings, share classes. */
  aliases?: Array<{
    ticker: string;
    exchange: string;
    shareClass?: string;
    from?: string;
    to?: string;
  }>;
  /** Share class (e.g. "A", "B", "C"). */
  shareClass?: string;
}

export interface CorporateAction {
  type: "split" | "spin-off" | "merger" | "ticker-change" | "delisting" | "restatement";
  effectiveDate: string; // as-of date
  ratio?: string;
  note?: string;
}

// ─── Periods and calendars ────────────────────────────────────────────

export type PeriodKind =
  "fiscal-q1" | "fiscal-q2" | "fiscal-q3" | "fiscal-q4" | "fiscal-year" | "half-year" | "calendar";

export interface FiscalPeriod {
  kind: PeriodKind;
  fiscalYear: number;
  /** Fiscal period number (1-4 for quarters, 1-2 for halves, 0 for full year). */
  period: number;
  /** Fiscal calendar label (e.g. "FY-ending-December"). */
  calendar?: string;
  endDate: string; // period end as-of date
}

// ─── Figure semantics ─────────────────────────────────────────────────

export type FigureBasis = "actual" | "estimate" | "guidance";
export type ReportingBasis = "reported" | "adjusted";
export type FigureStatus = "sourced" | "derived" | "assumed" | "unresolved" | "conflicting";

export interface Money {
  value: number;
  currency: string; // ISO 4217
  /** Scale/scale-unit, e.g. "millions", "thousands", "absolute". */
  scale: "absolute" | "thousands" | "millions" | "billions";
  /** Sign convention note (e.g. "expenses positive"). */
  signConvention?: string;
}

export interface PointInTime {
  /** As-of date (ISO) — the moment the value is valid for. */
  asOf: string;
  fiscalPeriod?: FiscalPeriod;
}

// ─── Source locator + precedence ──────────────────────────────────────

export interface SourceLocator {
  category: SourceCategory;
  /** Vendor/connector or "public-web-research". */
  source: string;
  /** Canonical URL, filing reference, or cell locator. */
  locator: string;
  retrievedAt: string;
  /** Optional snapshot/hash where policy permits. */
  snapshotHash?: string;
}

export interface SourcePrecedenceRule {
  category: SourceCategory;
  rank: number; // higher wins
  note?: string;
}

/**
 * Resolve which source wins on contradiction. Returns the higher-precedence
 * source; if equal rank and contradictory, returns a conflicting marker.
 */
export function resolvePrecedence(
  candidates: Array<{ locator: SourceLocator; value: Money }>,
  rules: SourcePrecedenceRule[],
): { winner: SourceLocator | null; conflicting: boolean } {
  if (candidates.length === 0) return { winner: null, conflicting: false };
  const ranked = candidates.map((c) => ({
    ...c,
    rank: rules.find((r) => r.category === c.locator.category)?.rank ?? 0,
  }));
  const maxRank = Math.max(...ranked.map((r) => r.rank));
  const top = ranked.filter((r) => r.rank === maxRank);
  if (top.length > 1) {
    // Equal precedence + different values → conflicting.
    const distinct = new Set(
      top.map((t) => `${t.value.value}|${t.value.currency}|${t.value.scale}`),
    );
    return { winner: top[0].locator, conflicting: distinct.size > 1 };
  }
  return { winner: top[0].locator, conflicting: false };
}

// ─── Material claim / figure record ───────────────────────────────────

export interface MaterialClaim {
  id: string;
  claim: string;
  value?: Money;
  pointInTime: PointInTime;
  source: SourceLocator;
  /** Transformation or calculation applied to the source value. */
  transformation?: string;
  status: FigureStatus;
  /** Reviewer + decision for this individual claim/cell/paragraph. */
  review?: {
    reviewer: string;
    decision: "accepted" | "rejected" | "pending";
    at: string;
    comment?: string;
  };
  /** Sensitivity of the underlying data. */
  sensitivity: SensitivityProfile;
}

// ─── Entitlement / redistribution ─────────────────────────────────────

export interface DataEntitlement {
  connector: string;
  datasets: SourceCategory[];
  redistributionAllowed: boolean;
  cacheExpirySeconds: number;
}

/** Check whether a source category is entitled for a connector. */
export function isEntitled(
  entitlements: DataEntitlement[],
  connector: string,
  category: SourceCategory,
): boolean {
  return entitlements.some(
    (e) => e.connector === connector && e.datasets.includes(category) && e.redistributionAllowed,
  );
}

// ─── Domain normalization checks ──────────────────────────────────────

export interface NormalizationIssue {
  field: keyof MaterialClaim;
  message: string;
}

/** Validate a MaterialClaim carries the mandatory point-in-time + source fields. */
export function validateMaterialClaim(claim: MaterialClaim): NormalizationIssue[] {
  const issues: NormalizationIssue[] = [];
  if (!claim.pointInTime?.asOf)
    issues.push({ field: "pointInTime", message: "missing as-of date" });
  if (!claim.source?.locator) issues.push({ field: "source", message: "missing source locator" });
  if (!claim.source?.retrievedAt)
    issues.push({ field: "source", message: "missing retrieved-at timestamp" });
  if (claim.value && !claim.value.currency)
    issues.push({ field: "value", message: "missing currency" });
  if (claim.value && !claim.value.scale)
    issues.push({ field: "value", message: "missing scale/unit" });
  if (claim.status === "sourced" && !claim.transformation && claim.value === undefined) {
    issues.push({ field: "status", message: "sourced claim has no value" });
  }
  return issues;
}

/** Normalize a fiscal period to a stable string key. */
export function periodKey(p: FiscalPeriod): string {
  return `${p.kind}:${p.fiscalYear}:${p.period}:${p.calendar ?? ""}`;
}

/**
 * Reconcile actual vs estimate vs guidance for the same metric/period. Returns
 * a status: conflicting if actual and estimate diverge beyond a tolerance.
 */
export function reconcileActualEstimate(
  actual: MaterialClaim | undefined,
  estimate: MaterialClaim | undefined,
  tolerancePct = 0,
): { status: FigureStatus; note: string } {
  if (actual && estimate && actual.value && estimate.value) {
    const sameUnit =
      actual.value.currency === estimate.value.currency &&
      actual.value.scale === estimate.value.scale;
    if (!sameUnit)
      return { status: "conflicting", note: "actual vs estimate unit/currency/scale mismatch" };
    const diff = Math.abs(actual.value.value - estimate.value.value);
    const base = Math.abs(estimate.value.value) || 1;
    const pct = (diff / base) * 100;
    if (pct > tolerancePct) {
      return {
        status: "conflicting",
        note: `actual vs estimate diverge by ${pct.toFixed(1)}% (tolerance ${tolerancePct}%)`,
      };
    }
    return { status: "sourced", note: "actual within estimate tolerance" };
  }
  if (actual) return { status: "sourced", note: "actual reported" };
  if (estimate) return { status: "assumed", note: "estimate only (no actual yet)" };
  return { status: "unresolved", note: "no actual or estimate" };
}
