/**
 * ResearchStateStore / TemporalEvidenceGraph — §13.
 *
 * A vendor-neutral store for point-in-time research state. Each claim is
 * versioned: a claim version distinguishes
 *   - validTime: when the fact was valid in the world (PointInTime.asOf)
 *   - recordedTime: when Quiver observed/recorded it
 *   - sourcePublicationTime: when the source published it (if known)
 *   - the kind: actual / estimate / guidance / assumption / derived
 *   - supersession: which earlier version this one supersedes
 *
 * Point-in-time queries return the state of knowledge AS OF a date — they
 * must NOT leak future information (a claim recorded after the as-of date is
 * excluded, even if its validTime is before).
 *
 * Destructive overwrites are forbidden: updating a claim creates a new version
 * with `supersedes`, leaving the old version intact.
 */

import type {
  MaterialClaim,
  SourceLocator,
  FiscalPeriod,
  FigureBasis,
  FigureStatus,
} from "./domain.js";
import type { SensitivityProfile } from "./interfaces.js";

export type ClaimKind = "actual" | "estimate" | "guidance" | "assumption" | "derived";

export interface ClaimVersion {
  /** The claim this version belongs to (stable across versions). */
  claimId: string;
  /** Monotonic version number for this claim. */
  version: number;
  /** When the fact was valid in the world. */
  validTime: string; // ISO date
  /** When Quiver observed/recorded this version. */
  recordedTime: string; // ISO timestamp
  /** When the source published it (if known). */
  sourcePublicationTime?: string;
  fiscalPeriod?: FiscalPeriod;
  kind: ClaimKind;
  basis?: FigureBasis;
  reportingBasis?: "reported" | "adjusted";
  /** The claim value/text for this version. */
  claim: string;
  value?: { value: number; currency: string; scale: string; unit?: string };
  status: FigureStatus;
  source: SourceLocator;
  sensitivity: SensitivityProfile;
  /** Version this one supersedes (version n-1), if any. */
  supersedes?: number;
  /** Whether this version is contradicted by a later version. */
  contradictedBy?: number;
  /** Evidence references supporting this version. */
  evidence?: string[];
}

export interface Entity {
  id: string;
  name: string;
  aliases?: string[];
  vendorIds?: Array<{ vendor: string; id: string }>;
}

export type EdgeKind =
  | "supplier-customer"
  | "competitor-peer"
  | "portfolio-holding"
  | "benchmark-constituent"
  | "geographic-exposure"
  | "commodity-input-exposure"
  | "regulation-exposure"
  | "kpi-to-thesis"
  | "thesis-to-risk"
  | "source-supports-claim"
  | "source-contradicts-claim";

export interface EvidenceEdge {
  id: string;
  kind: EdgeKind;
  from: string; // entity/claim id
  to: string;
  /** Whether the edge is verified (fact) or a hypothesis (unverified LLM proposal). */
  verified: boolean;
  /** Evidence supporting the edge. */
  evidence?: string[];
  recordedTime: string;
  validTime?: string;
}

export class ResearchStateStore {
  /** claimId → versions (ascending version number). */
  private claims = new Map<string, ClaimVersion[]>();
  private entities = new Map<string, Entity>();
  private edges: EvidenceEdge[] = [];

  registerEntity(e: Entity): void {
    this.entities.set(e.id, e);
  }

  entity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  /**
   * Record a new claim version. Non-destructive: appends a version with
   * supersedes = previous latest version. Returns the new version record.
   */
  recordClaim(
    input: Omit<ClaimVersion, "version" | "supersedes" | "contradictedBy">,
  ): ClaimVersion {
    const existing = this.claims.get(input.claimId) ?? [];
    const version = existing.length + 1;
    const prev = existing[existing.length - 1];
    const rec: ClaimVersion = {
      ...input,
      version,
      supersedes: prev?.version,
    };
    // If the new value contradicts the previous, mark the previous contradicted.
    if (prev && rec.value && prev.value && valuesDiffer(prev.value, rec.value)) {
      prev.contradictedBy = version;
    }
    existing.push(rec);
    this.claims.set(input.claimId, existing);
    return rec;
  }

  /** The latest version of a claim (or null if unknown). */
  latest(claimId: string): ClaimVersion | null {
    const arr = this.claims.get(claimId);
    return arr?.[arr.length - 1] ?? null;
  }

  /** All versions of a claim (for diff/supersession inspection). */
  history(claimId: string): ClaimVersion[] {
    return [...(this.claims.get(claimId) ?? [])];
  }

  /**
   * Point-in-time query: return the claim version that was KNOWN as of the
   * given date. A version is "known as of D" iff recordedTime <= D (future
   * leakage is impossible: a version recorded after D is excluded even if its
   * validTime is before D). Among known versions, the latest by recordedTime
   * wins; ties broken by version number.
   */
  asOf(claimId: string, asOfDate: string): ClaimVersion | null {
    const arr = this.claims.get(claimId);
    if (!arr) return null;
    const known = arr.filter((v) => v.recordedTime <= asOfDate);
    if (known.length === 0) return null;
    known.sort((a, b) => {
      // Latest recordedTime first; tie-break by highest version.
      if (b.recordedTime > a.recordedTime) return 1;
      if (b.recordedTime < a.recordedTime) return -1;
      return b.version - a.version;
    });
    return known[0];
  }

  /**
   * What changed for a claim between two dates (recorded, not valid, time).
   * Returns versions recorded in (prevDate, newDate].
   */
  changesBetween(claimId: string, prevDate: string, newDate: string): ClaimVersion[] {
    const arr = this.claims.get(claimId) ?? [];
    return arr.filter((v) => v.recordedTime > prevDate && v.recordedTime <= newDate);
  }

  /**
   * Whether a conclusion recorded at `conclusionDate` was based only on
   * information available at that time (no future-leaked evidence).
   */
  basedOnAvailableEvidence(
    claimId: string,
    conclusionDate: string,
    evidenceClaimIds: string[],
  ): boolean {
    return evidenceClaimIds.every((eid) => {
      const asOf = this.asOf(eid, conclusionDate);
      return asOf !== null; // every piece of evidence was known by conclusionDate
    });
  }

  addEdge(edge: EvidenceEdge): void {
    this.edges.push(edge);
  }

  /** Edges from an entity/claim (for impact traversal). */
  edgesFrom(id: string): EvidenceEdge[] {
    return this.edges.filter((e) => e.from === id);
  }

  /** Unverified edges (hypotheses proposed by the LLM, not yet confirmed). */
  hypotheses(): EvidenceEdge[] {
    return this.edges.filter((e) => !e.verified);
  }

  /** All recorded edges (for audit). */
  allEdges(): EvidenceEdge[] {
    return [...this.edges];
  }

  /** Export the full state (for snapshot/audit). */
  export(): { claims: ClaimVersion[][]; entities: Entity[]; edges: EvidenceEdge[] } {
    return {
      claims: Array.from(this.claims.values()).map((arr) => arr.map((v) => ({ ...v }))),
      entities: Array.from(this.entities.values()).map((e) => ({ ...e })),
      edges: this.edges.map((e) => ({ ...e })),
    };
  }
}

function valuesDiffer(
  a: NonNullable<ClaimVersion["value"]>,
  b: NonNullable<ClaimVersion["value"]>,
): boolean {
  return a.value !== b.value || a.currency !== b.currency || a.scale !== b.scale;
}

// ─── Helpers to build claims from the legacy MaterialClaim ────────────

export function claimFromMaterial(
  mc: MaterialClaim,
  kind: ClaimKind,
  recordedTime: string,
): Omit<ClaimVersion, "version" | "supersedes" | "contradictedBy"> {
  return {
    claimId: mc.id,
    validTime: mc.pointInTime.asOf,
    recordedTime,
    fiscalPeriod: mc.pointInTime.fiscalPeriod,
    kind,
    claim: mc.claim,
    value: mc.value
      ? { value: mc.value.value, currency: mc.value.currency, scale: mc.value.scale }
      : undefined,
    status: mc.status,
    source: mc.source,
    sensitivity: mc.sensitivity,
  };
}
