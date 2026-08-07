/**
 * Checker vision — feed the VP the same native multimodal attachments the
 * Associate uses.
 *
 * The harness trusts multimodal models with text, images, and documents.
 * Cited Evidence.json sources are attached via `[File: path]` →
 * `processFileMarkers` (images as `image_url`, PDFs/documents as `file`
 * parts). No PDF→PNG conversion or OCR in this path — OfficeCLI remains
 * for surgical/deterministic Office create/edit only.
 *
 * Fail-closed: if a required source cannot be encoded, model evaluation
 * throws and the checker rejects (never approves blind).
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  processFileMarkers,
  type FileContent,
  validateImageMagic,
  validatePdfMagic,
  validateZipMagic,
} from "../file_encoder.js";
import { readEvidenceFile } from "../evidence/validator.js";
import type { EvidenceModel, SourceRecord } from "../evidence/model.js";

/** Hard cap so a huge data room cannot blow the checker context window. */
export const CHECKER_MAX_ATTACHMENTS = 12;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const NATIVE_DOC_EXT = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

export interface CheckerVisionBuildResult {
  content: FileContent;
  attachmentCount: number;
  requiredAttachments: number;
  /** @deprecated use attachmentCount — kept for older call sites */
  imageCount: number;
  /** @deprecated use requiredAttachments */
  requiredImages: number;
  notes: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingPath(
  raw: string,
  deliverablePath: string,
  workspaceRoot: string,
): Promise<string | null> {
  if (!raw) return null;
  if (path.isAbsolute(raw)) {
    return (await pathExists(raw)) ? raw : null;
  }
  const beside = path.resolve(path.dirname(deliverablePath), raw);
  if (await pathExists(beside)) return beside;
  const fromWs = path.resolve(workspaceRoot, raw);
  if (await pathExists(fromWs)) return fromWs;
  const parent = path.resolve(path.dirname(deliverablePath), "..", raw);
  if (await pathExists(parent)) return parent;
  return null;
}

function isImagePath(p: string): boolean {
  return IMAGE_EXT.has(path.extname(p).toLowerCase());
}

function isNativeDocPath(p: string): boolean {
  return NATIVE_DOC_EXT.has(path.extname(p).toLowerCase());
}

function looksNativeAttachment(source: SourceRecord): boolean {
  const ext = path.extname(source.file || "").toLowerCase();
  return (
    IMAGE_EXT.has(ext) ||
    NATIVE_DOC_EXT.has(ext) ||
    source.source_type === "filing" ||
    source.source_type === "transcript"
  );
}

function collectSources(model: EvidenceModel): SourceRecord[] {
  const byId = new Map<string, SourceRecord>();
  for (const s of model.sources || []) {
    if (s?.source_id) byId.set(s.source_id, s);
  }
  return [...byId.values()];
}

function countEncodedAttachments(content: FileContent): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => p.type === "image_url" || p.type === "file").length;
}

/**
 * Build multimodal user content for the checker model evaluation.
 *
 * @throws when a required native source cannot be prepared or encoded
 */
export async function buildCheckerVisionContent(input: {
  deliverablePath: string;
  deliverableContent: string;
  evidenceLines: string[];
  toolName?: string;
  workspaceRoot?: string;
}): Promise<CheckerVisionBuildResult> {
  const workspaceRoot = input.workspaceRoot || process.cwd();
  const notes: string[] = [];
  const markerBlocks: string[] = [];
  let requiredAttachments = 0;
  let plannedAttachments = 0;

  const textHeader = [
    `Tool that produced this work: ${input.toolName || "unknown"}`,
    `Deliverable path: ${input.deliverablePath || "n/a"}`,
    "",
    "Deterministic evidence:",
    ...input.evidenceLines.map((e) => `  - ${e}`),
    "",
  ];

  // Attach the deliverable itself when it is a native multimodal file.
  // Do not screenshot or re-render — the model receives the raw bytes.
  if (input.deliverablePath) {
    const ext = path.extname(input.deliverablePath).toLowerCase();
    if (IMAGE_EXT.has(ext) || NATIVE_DOC_EXT.has(ext)) {
      if (await pathExists(input.deliverablePath)) {
        if (plannedAttachments < CHECKER_MAX_ATTACHMENTS) {
          plannedAttachments++;
          markerBlocks.push(`Deliverable (native attachment):\n[File: ${input.deliverablePath}]`);
          notes.push(`deliverable attached: ${path.basename(input.deliverablePath)}`);
        }
      }
    }
  }

  // Evidence-backed sources (required when present and natively attachable).
  if (input.deliverablePath) {
    const ev = await readEvidenceFile(input.deliverablePath);
    if (ev.model) {
      const sources = collectSources(ev.model);
      for (const source of sources) {
        if (plannedAttachments >= CHECKER_MAX_ATTACHMENTS) {
          notes.push(
            `attachment cap (${CHECKER_MAX_ATTACHMENTS}) reached — remaining sources summarized as text`,
          );
          break;
        }

        const resolved = await resolveExistingPath(
          source.file,
          input.deliverablePath,
          workspaceRoot,
        );

        if (!resolved) {
          if (looksNativeAttachment(source)) {
            throw new Error(
              `Checker vision: required source file missing (${source.source_id}: ${source.file})`,
            );
          }
          markerBlocks.push(
            `Source ${source.source_id} (${source.title}): file not on disk — excerpt: ${(source.excerpt || source.extracted_value || "").slice(0, 400)}`,
          );
          continue;
        }

        if (isImagePath(resolved)) {
          if (!validateImageMagic(resolved)) {
            throw new Error(
              `Checker vision: source ${source.source_id} failed image magic validation (${resolved})`,
            );
          }
          requiredAttachments++;
          plannedAttachments++;
          markerBlocks.push(`Source ${source.source_id} — ${source.title}:\n[File: ${resolved}]`);
          continue;
        }

        if (isNativeDocPath(resolved)) {
          const ext = path.extname(resolved).toLowerCase();
          if (ext === ".pdf" && !validatePdfMagic(resolved)) {
            throw new Error(
              `Checker vision: source ${source.source_id} failed PDF magic validation (${resolved})`,
            );
          }
          if ([".docx", ".xlsx", ".pptx"].includes(ext) && !validateZipMagic(resolved)) {
            throw new Error(
              `Checker vision: source ${source.source_id} failed Office package magic validation (${resolved})`,
            );
          }
          requiredAttachments++;
          plannedAttachments++;
          const loc = source.location?.page != null ? ` (cited p.${source.location.page})` : "";
          markerBlocks.push(
            `Source ${source.source_id} — ${source.title}${loc}:\n[File: ${resolved}]`,
          );
          continue;
        }

        // Non-file / text-ish sources: textual summary for the checker.
        const loc = source.location || {};
        const locBits = [
          loc.sheet && loc.cell ? `${loc.sheet}!${loc.cell}` : null,
          loc.section,
          loc.page != null ? `p.${loc.page}` : null,
          loc.url,
        ]
          .filter(Boolean)
          .join(" · ");
        markerBlocks.push(
          `Source ${source.source_id} — ${source.title}` +
            (locBits ? ` (${locBits})` : "") +
            (source.extracted_value ? `: ${source.extracted_value}` : "") +
            (source.excerpt ? `\nExcerpt: ${source.excerpt.slice(0, 500)}` : ""),
        );
      }
    } else if (input.toolName === "office_doc") {
      notes.push("no Evidence.json model available for source attachment");
    }
  }

  const textTail = [
    "",
    "Deliverable text excerpt (truncated — prefer attached native files when present):",
    input.deliverableContent || "[no file content]",
    "",
    "Evaluate this work for correctness, source traceability, uncertainty disclosure, and professional usability.",
    "When images or documents are attached, inspect them directly and confirm cited figures/tables against those files.",
    'Return JSON: {"verdict": "...", "reasoning": "..."}',
  ];

  const assembled =
    [...textHeader, ...markerBlocks, ...textTail].join("\n") +
    (notes.length ? `\n\nVision notes: ${notes.join("; ")}` : "");

  const content = await processFileMarkers(assembled);
  const attachmentCount = countEncodedAttachments(content);

  // Fail-closed: every required native source must become an image_url or file part.
  if (requiredAttachments > 0 && attachmentCount < requiredAttachments) {
    throw new Error(
      `Checker vision encoding incomplete: required ${requiredAttachments} attachment(s), encoded ${attachmentCount}`,
    );
  }

  return {
    content,
    attachmentCount,
    requiredAttachments,
    imageCount: attachmentCount,
    requiredImages: requiredAttachments,
    notes,
  };
}
