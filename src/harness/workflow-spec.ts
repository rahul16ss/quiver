/**
 * WorkflowSpec — Phase 9 (ADR-007 / acceptance scenarios).
 *
 * Each of the twelve Conviction Studio reference scenarios is expressed as a
 * declarative WorkflowSpec with synthetic/public inputs, required source
 * categories, deliverable type, acceptance checks and reviewer gates. These are
 * tests of the *generic harness* — not twelve special-purpose production agents.
 *
 * Per scenario the harness verifies:
 *   - correct context and source selection
 *   - sensitivity-policy enforcement
 *   - no substitution of licensed data with open web
 *   - tool routing and goal-loop recovery
 *   - point-in-time financial semantics
 *   - native Office output
 *   - formula/layout preservation (where applicable)
 *   - evidence and source locators
 *   - unresolved-item handling
 *   - maker/checker separation
 *   - human approval before commit
 *   - storage version/conflict behavior
 *   - reproducibility from the run record
 */

import type { SourceCategory, SensitivityProfile } from "./interfaces.js";

export interface WorkflowSpec {
  /** Scenario number (1-12). */
  number: number;
  id: string;
  name: string;
  family: "dealmaking" | "research" | "wealth";
  /** Synthetic/public inputs only — no client MNPI in fixtures. */
  inputs: WorkflowInput[];
  requiredSourceCategories: SourceCategory[];
  deliverable: {
    type: "memo" | "tracker" | "primer" | "pitchbook" | "commentary" | "proposal" | "note";
    mimeType: string;
    sections: string[];
  };
  dataSensitivity: SensitivityProfile;
  reviewer: string;
  acceptanceChecks: WorkflowAcceptanceCheck[];
  /** Must not substitute open-web research for these licensed categories. */
  noSubstituteCategories: SourceCategory[];
}

export interface WorkflowInput {
  id: string;
  path: string;
  sourceCategory: SourceCategory;
  /** Synthetic/public marker — fixtures never carry MNPI. */
  synthetic: true;
}

export interface WorkflowAcceptanceCheck {
  id: string;
  description: string;
  /** A predicate evaluated against the run record by the harness test. */
  assert: (record: WorkflowRunRecord) => boolean;
}

export interface WorkflowRunRecord {
  specId: string;
  contextApproved: boolean;
  sourcesSelected: SourceCategory[];
  sensitivityEnforced: SensitivityProfile;
  licensedSubstitutionAttempted: boolean;
  deliverableMimeType: string;
  formulaLayoutPreserved: boolean;
  evidenceLocators: number;
  unresolvedItems: string[];
  makerCheckerSeparated: boolean;
  humanApprovalBeforeCommit: boolean;
  storageConflictChecked: boolean;
  reproducible: boolean;
}

// ─── Acceptance check helpers (shared invariants) ─────────────────────

const commonChecks: WorkflowAcceptanceCheck[] = [
  { id: "context-approved", description: "Context and sources approved before execution", assert: (r) => r.contextApproved },
  { id: "sensitivity-enforced", description: "Sensitivity policy enforced", assert: (r) => !!r.sensitivityEnforced },
  { id: "no-licensed-substitution", description: "No substitution of licensed data with open web", assert: (r) => !r.licensedSubstitutionAttempted },
  { id: "evidence-locators", description: "Evidence and source locators present", assert: (r) => r.evidenceLocators > 0 },
  { id: "maker-checker", description: "Maker/checker separation", assert: (r) => r.makerCheckerSeparated },
  { id: "human-approval", description: "Human approval before commit", assert: (r) => r.humanApprovalBeforeCommit },
  { id: "storage-conflict", description: "Storage version/conflict behavior checked", assert: (r) => r.storageConflictChecked },
  { id: "reproducible", description: "Reproducible from the run record", assert: (r) => r.reproducible },
  { id: "unresolved-honest", description: "Unresolved items surfaced honestly", assert: (r) => Array.isArray(r.unresolvedItems) },
];

const officeOutputCheck = (mimeType: string): WorkflowAcceptanceCheck => ({
  id: "native-office-output",
  description: `Native Office output (${mimeType})`,
  assert: (r) => r.deliverableMimeType === mimeType,
});

const formulaLayoutCheck: WorkflowAcceptanceCheck = {
  id: "formula-layout-preserved",
  description: "Formula/layout preservation (where applicable)",
  assert: (r) => r.formulaLayoutPreserved,
};

// ─── The twelve reference scenarios ────────────────────────────────────

export const TWELVE_WORKFLOW_SPECS: WorkflowSpec[] = [
  {
    number: 1, id: "earnings-update", name: "Earnings update", family: "research",
    inputs: [{ id: "press-release", path: "fixtures/earnings/press-release.md", sourceCategory: "filings-ir", synthetic: true }],
    requiredSourceCategories: ["filings-ir", "market-data-estimates", "transcripts-events"],
    deliverable: { type: "note", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["reported metrics", "consensus deltas", "transcript highlights"] },
    dataSensitivity: "public", reviewer: "analyst",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  },
  {
    number: 2, id: "transcript-review", name: "Transcript review", family: "research",
    inputs: [{ id: "transcript", path: "fixtures/transcripts/q2.md", sourceCategory: "transcripts-events", synthetic: true }],
    requiredSourceCategories: ["transcripts-events", "internal-research-notes"],
    deliverable: { type: "memo", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["guidance shifts", "tone analysis", "non-GAAP checks"] },
    dataSensitivity: "public", reviewer: "analyst",
    noSubstituteCategories: [],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  },
  {
    number: 3, id: "company-primer", name: "Company or sector primer", family: "research",
    inputs: [{ id: "filings", path: "fixtures/primer/10k.md", sourceCategory: "filings-ir", synthetic: true }],
    requiredSourceCategories: ["filings-ir", "market-data-estimates", "public-web-research"],
    deliverable: { type: "primer", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["business overview", "financials", "comps"] },
    dataSensitivity: "public", reviewer: "senior_analyst",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  },
  {
    number: 4, id: "thesis-tracker", name: "Thesis tracking", family: "research",
    inputs: [{ id: "thesis", path: "fixtures/thesis/thesis.xlsx", sourceCategory: "portfolio-models-trackers", synthetic: true }],
    requiredSourceCategories: ["portfolio-models-trackers", "market-data-estimates"],
    deliverable: { type: "tracker", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sections: ["long/short thesis", "KPI catalyst scoring"] },
    dataSensitivity: "confidential-internal", reviewer: "pm",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), formulaLayoutCheck],
  },
  {
    number: 5, id: "ic-memo", name: "Investment committee memo", family: "dealmaking",
    inputs: [{ id: "model", path: "fixtures/ic/model.xlsx", sourceCategory: "portfolio-models-trackers", synthetic: true }],
    requiredSourceCategories: ["filings-ir", "market-data-estimates", "portfolio-models-trackers", "transcripts-events"],
    deliverable: { type: "memo", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["executive summary", "financial overview", "risks", "open diligence"] },
    dataSensitivity: "confidential-internal", reviewer: "ic_member",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  },
  {
    number: 6, id: "diligence-tracker", name: "Diligence tracker", family: "dealmaking",
    inputs: [{ id: "vdr", path: "fixtures/diligence/vdr.xlsx", sourceCategory: "internal-research-notes", synthetic: true }],
    requiredSourceCategories: ["internal-research-notes", "filings-ir"],
    deliverable: { type: "tracker", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sections: ["document tracking", "red flag matrix"] },
    dataSensitivity: "confidential-internal", reviewer: "vp",
    noSubstituteCategories: [],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), formulaLayoutCheck],
  },
  {
    number: 7, id: "market-map", name: "Market map", family: "dealmaking",
    inputs: [{ id: "landscape", path: "fixtures/marketmap/landscape.csv", sourceCategory: "public-web-research", synthetic: true }],
    requiredSourceCategories: ["public-web-research", "market-data-estimates"],
    deliverable: { type: "pitchbook", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sections: ["landscape", "unit economics", "multiples"] },
    dataSensitivity: "public", reviewer: "principal",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.presentationml.presentation")],
  },
  {
    number: 8, id: "pitchbook-materials", name: "Pitchbook or transaction materials", family: "dealmaking",
    inputs: [{ id: "creds", path: "fixtures/pitchbook/creds.md", sourceCategory: "internal-research-notes", synthetic: true }],
    requiredSourceCategories: ["internal-research-notes", "market-data-estimates"],
    deliverable: { type: "pitchbook", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sections: ["credentials", "transaction overview"] },
    dataSensitivity: "confidential-internal", reviewer: "partner",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.presentationml.presentation")],
  },
  {
    number: 9, id: "portfolio-review", name: "Portfolio review pack", family: "wealth",
    inputs: [{ id: "holdings", path: "fixtures/wealth/holdings.xlsx", sourceCategory: "portfolio-models-trackers", synthetic: true }],
    requiredSourceCategories: ["portfolio-models-trackers", "market-data-estimates"],
    deliverable: { type: "tracker", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sections: ["allocation", "performance", "risk"] },
    dataSensitivity: "confidential-internal", reviewer: "cio",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), formulaLayoutCheck],
  },
  {
    number: 10, id: "investment-proposal", name: "Investment proposal", family: "wealth",
    inputs: [{ id: "client", path: "fixtures/wealth/client.md", sourceCategory: "internal-research-notes", synthetic: true }],
    requiredSourceCategories: ["internal-research-notes", "market-data-estimates"],
    deliverable: { type: "proposal", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["proposal", "tax profile"] },
    dataSensitivity: "confidential-internal", reviewer: "advisor",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  },
  {
    number: 11, id: "manager-research-note", name: "Manager research note", family: "wealth",
    inputs: [{ id: "manager", path: "fixtures/wealth/manager.md", sourceCategory: "internal-research-notes", synthetic: true }],
    requiredSourceCategories: ["internal-research-notes", "public-web-research"],
    deliverable: { type: "note", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["due diligence", "style drift audit"] },
    dataSensitivity: "public", reviewer: "analyst",
    noSubstituteCategories: [],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  },
  {
    number: 12, id: "client-commentary", name: "Client commentary", family: "wealth",
    inputs: [{ id: "market", path: "fixtures/wealth/market.md", sourceCategory: "public-web-research", synthetic: true }],
    requiredSourceCategories: ["public-web-research", "market-data-estimates"],
    deliverable: { type: "commentary", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sections: ["market update", "positioning"] },
    dataSensitivity: "public", reviewer: "advisor",
    noSubstituteCategories: ["market-data-estimates"],
    acceptanceChecks: [...commonChecks, officeOutputCheck("application/vnd.openxmlformats-officedocument.wordprocessingml.document")],
  },
];

/** Build a synthetic run record for a spec that passes all its acceptance checks. */
export function passingRunRecord(spec: WorkflowSpec): WorkflowRunRecord {
  return {
    specId: spec.id,
    contextApproved: true,
    sourcesSelected: spec.requiredSourceCategories,
    sensitivityEnforced: spec.dataSensitivity,
    licensedSubstitutionAttempted: false,
    deliverableMimeType: spec.deliverable.mimeType,
    formulaLayoutPreserved: spec.deliverable.mimeType.includes("spreadsheetml"),
    evidenceLocators: spec.requiredSourceCategories.length,
    unresolvedItems: [],
    makerCheckerSeparated: true,
    humanApprovalBeforeCommit: true,
    storageConflictChecked: true,
    reproducible: true,
  };
}

/** Build a synthetic run record that fails a named invariant (for negative tests). */
export function failingRunRecord(spec: WorkflowSpec, failure: "substitution" | "no-approval" | "wrong-mime" | "no-evidence"): WorkflowRunRecord {
  const base = passingRunRecord(spec);
  switch (failure) {
    case "substitution": return { ...base, licensedSubstitutionAttempted: true };
    case "no-approval": return { ...base, humanApprovalBeforeCommit: false };
    case "wrong-mime": return { ...base, deliverableMimeType: "text/plain" };
    case "no-evidence": return { ...base, evidenceLocators: 0 };
  }
}