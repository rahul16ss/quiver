/**
 * Strict persisted-evidence validation.
 *
 * Evidence is a contract between the maker, checker, GUI, and Office
 * deliverable. JSON.parse alone is not validation: an empty object or a
 * partially written file must never be treated as a valid evidence package.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { ClaimRecord, EvidenceModel, SourceRecord } from "./model.js";

const SOURCE_TYPES = new Set([
  "excel_model",
  "filing",
  "transcript",
  "internal_note",
  "vendor_export",
  "web",
  "template",
  "research_report",
  "news",
  "other",
]);
const RELATIONSHIPS = new Set(["sourced", "derived", "estimate", "unresolved"]);
const REVIEW_STATUSES = new Set(["verified", "needs_analyst", "flagged", "unresolved"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string, problems: string[]): void {
  if (typeof value[key] !== "string" || !value[key].trim()) {
    problems.push(`${key} must be a non-empty string`);
  }
}

function stringField(value: Record<string, unknown>, key: string, problems: string[]): void {
  if (typeof value[key] !== "string") {
    problems.push(`${key} must be a string`);
  }
}

function validateSource(value: unknown, index: number, problems: string[]): value is SourceRecord {
  if (!isRecord(value)) {
    problems.push(`sources[${index}] must be an object`);
    return false;
  }
  for (const key of ["source_id", "title", "file", "as_of", "sensitivity"]) {
    requiredString(value, key, problems);
  }
  if (typeof value.source_type !== "string" || !SOURCE_TYPES.has(value.source_type)) {
    problems.push(`sources[${index}].source_type is invalid`);
  }
  if (!isRecord(value.location)) {
    problems.push(`sources[${index}].location must be an object`);
  }
  if (typeof value.approved !== "boolean") {
    problems.push(`sources[${index}].approved must be boolean`);
  }
  return true;
}

function validateClaim(value: unknown, index: number, problems: string[]): value is ClaimRecord {
  if (!isRecord(value)) {
    problems.push(`claims[${index}] must be an object`);
    return false;
  }
  for (const key of ["claim_id", "rendered_text"]) {
    requiredString(value, key, problems);
  }
  if (
    !Array.isArray(value.source_ids) ||
    value.source_ids.some((sourceId) => typeof sourceId !== "string")
  ) {
    problems.push(`claims[${index}].source_ids must be an array of strings`);
  }
  if (typeof value.relationship !== "string" || !RELATIONSHIPS.has(value.relationship)) {
    problems.push(`claims[${index}].relationship is invalid`);
  }
  if (typeof value.review_status !== "string" || !REVIEW_STATUSES.has(value.review_status)) {
    problems.push(`claims[${index}].review_status is invalid`);
  }
  if (value.reviewer_decision !== null && typeof value.reviewer_decision !== "string") {
    problems.push(`claims[${index}].reviewer_decision must be null or a string`);
  }
  if (typeof value.is_quantitative !== "boolean") {
    problems.push(`claims[${index}].is_quantitative must be boolean`);
  }
  return true;
}

/**
 * Validate the persisted EvidenceModel shape without trusting a type cast.
 */
export function validateEvidenceModel(value: unknown): {
  valid: boolean;
  problems: string[];
  model?: EvidenceModel;
} {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, problems: ["evidence must be a JSON object"] };
  }

  for (const key of [
    "label",
    "workflow",
    "workflow_version",
    "as_of",
    "date_line",
    "generated_at",
  ]) {
    requiredString(value, key, problems);
  }
  for (const key of ["company", "title", "subtitle"]) {
    stringField(value, key, problems);
  }
  if (value.review_status !== "draft_for_review") {
    problems.push("review_status must be draft_for_review");
  }
  if (value.generated_by !== "live_agent") {
    problems.push("generated_by must be live_agent");
  }
  if (!Array.isArray(value.sources)) {
    problems.push("sources must be an array");
  } else {
    value.sources.forEach((source, index) => validateSource(source, index, problems));
  }
  if (!Array.isArray(value.claims)) {
    problems.push("claims must be an array");
  } else {
    value.claims.forEach((claim, index) => validateClaim(claim, index, problems));
  }
  if (!Array.isArray(value.sources_excluded)) {
    problems.push("sources_excluded must be an array");
  } else {
    value.sources_excluded.forEach((excluded, index) => {
      if (
        !isRecord(excluded) ||
        typeof excluded.source_id !== "string" ||
        !excluded.source_id.trim() ||
        typeof excluded.reason !== "string" ||
        !excluded.reason.trim()
      ) {
        problems.push(`sources_excluded[${index}] must contain source_id and reason`);
      }
    });
  }

  return problems.length === 0
    ? { valid: true, problems: [], model: value as unknown as EvidenceModel }
    : { valid: false, problems };
}

export function evidencePathForDocument(documentPath: string): string {
  const baseName = path.basename(documentPath).replace(/\.(docx|xlsx|pptx)$/i, "");
  return path.join(path.dirname(documentPath), `${baseName}_Evidence.json`);
}

/**
 * Read the exact companion evidence file for a document.
 *
 * A missing, malformed, or structurally invalid companion is an explicit
 * failure. Callers may choose whether a missing file is required for their
 * workflow, but they must not mistake it for valid evidence.
 */
export async function readEvidenceFile(documentPath: string): Promise<{
  valid: boolean;
  missing: boolean;
  evidencePath: string;
  problems: string[];
  model?: EvidenceModel;
}> {
  const evidencePath = evidencePathForDocument(documentPath);
  let raw: string;
  try {
    raw = await fs.readFile(evidencePath, "utf8");
  } catch {
    return {
      valid: false,
      missing: true,
      evidencePath,
      problems: [`Evidence file is missing: ${evidencePath}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      missing: false,
      evidencePath,
      problems: ["Evidence file contains malformed JSON"],
    };
  }

  const result = validateEvidenceModel(parsed);
  return {
    ...result,
    missing: false,
    evidencePath,
  };
}
