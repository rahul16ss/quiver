/**
 * ModelProfile — Phase 2 (ADR-001).
 *
 * Versioned, certified records of model capability. Capabilities are NOT
 * inferred from branding; they are certified with live, opt-in contract tests.
 * A profile that has not passed its contract test for a MIME type may not be
 * used for native ingestion of that MIME type — the client fails closed.
 */

import * as fs from "fs";
import * as path from "path";
import type { SensitivityProfile } from "./interfaces.js";

export type NativeMime =
  | "application/pdf"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "image/png"
  | "image/jpeg";

export interface ModelProfile {
  /** Stable slug, e.g. "openai-gpt-4o-pdf-native". */
  slug: string;
  /** OpenRouter model slug, e.g. "openai/gpt-4o". */
  modelSlug: string;
  /** Approved provider order (no automatic router; no unapproved fallback). */
  providerOrder: string[];
  /** MIME types proven to be accepted natively (by contract test). */
  testedNativeMimeTypes: NativeMime[];
  supportsToolCalling: boolean;
  supportsStrictOutput: boolean;
  contextWindowTokens: number;
  maxFileBytes: number;
  /** Zero-Data-Retention eligibility (must be true for any cloud route). */
  zdrEligible: boolean;
  /** Whether this profile may serve the independent checker role. */
  checkerEligible: boolean;
  /** Whether the underlying model accepts `file` input natively (input_modalities ⊇ file).
   *  Native-document ingestion is only permitted on such profiles — never via OCR fallback. */
  nativeFileInput: boolean;
  /** Router role this profile is the preferred pick for (see ModalityRouter). */
  routerRole?: "planner" | "maker" | "checker" | "reviewer" | "failsafe";
  /** Optional pack-declared role allowlist: when present, the profile may only
   *  serve these router roles (a pack entry with roles [checker, reviewer] is
   *  honored for BOTH, not just the first). Absent → any role. */
  allowedRoles?: Array<"planner" | "maker" | "checker" | "reviewer" | "failsafe">;
  /** Sensitivity profiles this profile is approved for. */
  approvedFor: SensitivityProfile[];
  /** Last contract-test date (ISO) and pass/fail. */
  lastContractTest: { date: string; result: "pass" | "fail" | "not-run" };
  /** PDF engine to force when sending PDFs natively. */
  pdfEngine: "native" | "mistral-ocr" | "pdf-text";
}

/**
 * A registry of certified profiles. Profiles are data; a deployment loads them
 * from a customer pack or a shipped catalog. Profiles that have not passed
 * contract tests are marked `not-run` and the client refuses native ingestion.
 */
export class ModelProfileRegistry {
  private profiles = new Map<string, ModelProfile>();

  register(profile: ModelProfile): void {
    this.profiles.set(profile.slug, profile);
  }

  get(slug: string): ModelProfile | undefined {
    return this.profiles.get(slug);
  }

  /** Find a profile approved for a role + sensitivity, preferring ZDR-eligible. */
  pick(
    role: "planner" | "maker" | "checker" | "reviewer",
    sensitivity: SensitivityProfile,
  ): ModelProfile | undefined {
    const eligible = Array.from(this.profiles.values()).filter(
      (p) => p.approvedFor.includes(sensitivity) && (role !== "checker" || p.checkerEligible),
    );
    if (sensitivity === "restricted-mnpi") {
      // Restricted/MNPI must use a local/private route — never a cloud profile.
      return undefined;
    }
    return eligible.find((p) => p.zdrEligible) ?? eligible[0];
  }

  /** Certify a profile's native support for a MIME type (called by contract tests). */
  certify(slug: string, mime: NativeMime, result: "pass" | "fail"): void {
    const p = this.profiles.get(slug);
    if (!p) throw new Error(`Unknown profile: ${slug}`);
    if (result === "pass" && !p.testedNativeMimeTypes.includes(mime)) {
      p.testedNativeMimeTypes.push(mime);
    } else if (result === "fail") {
      p.testedNativeMimeTypes = p.testedNativeMimeTypes.filter((m) => m !== mime);
    }
    p.lastContractTest = { date: new Date().toISOString(), result };
  }

  list(): ModelProfile[] {
    return Array.from(this.profiles.values());
  }
}

/**
 * Whether a profile is certified for native ingestion of a given MIME type.
 * Membership in testedNativeMimeTypes is the per-MIME truth (certify() adds on
 * pass, removes on fail). The profile-level lastContractTest only proves a
 * test ran — it must NOT gate per-MIME: a later DOCX fail would otherwise
 * poison an earlier PDF pass (the "one mutable value" trap the capability
 * registry exists to avoid).
 */
export function isCertifiedFor(profile: ModelProfile, mime: NativeMime): boolean {
  return (
    profile.testedNativeMimeTypes.includes(mime) && profile.lastContractTest.result !== "not-run"
  );
}

/**
 * Apply a customer pack's `approvedModels` to a profile registry — restricts
 * the registry to only the profiles the pack approves, and overrides each
 * approved profile's provider order with the pack's. Any profile in the base
 * catalog that the pack does NOT approve is removed, so the router can never
 * silently pick an unapproved cloud model (fail closed). Returns a NEW
 * registry; the input is left intact.
 */
export function applyApprovedModels(
  base: ModelProfileRegistry,
  approved: Array<{
    profileSlug: string;
    roles?: Array<"planner" | "maker" | "checker" | "reviewer">;
    providerOrder: string[];
  }>,
): ModelProfileRegistry {
  const out = new ModelProfileRegistry();
  for (const entry of approved) {
    const p = base.get(entry.profileSlug);
    if (!p) continue; // pack references an unknown profile → ignored (honest)
    const merged: ModelProfile = {
      ...p,
      providerOrder: entry.providerOrder.length > 0 ? entry.providerOrder : p.providerOrder,
      // Honor the pack's FULL role list: an entry approving a profile for
      // [checker, reviewer] serves BOTH roles. Absent roles → any role.
      allowedRoles: entry.roles && entry.roles.length > 0 ? [...entry.roles] : p.allowedRoles,
      routerRole:
        entry.roles && entry.roles.length > 0
          ? (entry.roles[0] as ModelProfileRunnerRole)
          : p.routerRole,
    };
    out.register(merged);
  }
  return out;
}

type ModelProfileRunnerRole = "planner" | "maker" | "checker" | "reviewer" | "failsafe";

/**
 * Shipped catalog — the production tiered profiles (ADR-001 §5 router).
 * Grounded in live OpenRouter Models API data (Aug 2026, ZDR endpoints only).
 * See docs/model-router.md for selection rationale + benchmark scores.
 *
 * All profiles start `not-run`; native ingestion remains gated on the
 * CapabilityRegistry's per-MIME contract test (§6) — the router proposes,
 * certification disposes. A profile's `nativeFileInput` flag is the static
 * property (the model's documented input modalities); certification is the
 * dynamic, opt-in proof.
 */
export function starterCatalog(): ModelProfile[] {
  const approvedCloud: SensitivityProfile[] = ["public", "confidential-internal"];
  return [
    // ── Native-document tier (input_modalities ⊇ file) ───────────────
    {
      slug: "native-doc-frontier",
      modelSlug: "anthropic/claude-opus-5",
      providerOrder: ["Anthropic"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_000_000,
      maxFileBytes: 32 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: true,
      routerRole: "reviewer",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      slug: "native-doc-primary",
      modelSlug: "anthropic/claude-sonnet-5",
      providerOrder: ["Anthropic"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_000_000,
      maxFileBytes: 32 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: true,
      routerRole: "maker",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      slug: "native-doc-budget",
      modelSlug: "google/gemini-3.6-flash",
      providerOrder: ["Google"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_048_576,
      maxFileBytes: 32 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: true,
      routerRole: "maker",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      // Independent native-doc checker: Moonshot family ≠ Anthropic maker.
      // CorpFin v2 #3 (71.56%), EMB scratch 68.2% — strong document auditor.
      slug: "native-doc-checker",
      modelSlug: "moonshotai/kimi-k3",
      providerOrder: ["MoonshotAI"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_048_576,
      maxFileBytes: 32 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: true,
      // Live contract test 2026-08-08: every OpenRouter kimi-k3 provider
      // rejects `file` content parts ("invalid part type: file"). Kimi audits
      // via extracted text/receipts, not raw documents.
      nativeFileInput: false,
      routerRole: "checker",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    // ── Text-only tier (input_modalities = [text]) ───────────────────
    {
      // The planner (both tiers): GPT-5.6 Sol — EMB #3 (72.3%), Terminal-Bench
      // leader. Plans from text digests; file-capable so a native-file planning
      // call never fails closed.
      slug: "text-planner",
      modelSlug: "openai/gpt-5.6-sol",
      providerOrder: ["OpenAI"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_050_000,
      maxFileBytes: 32 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: false,
      nativeFileInput: true,
      routerRole: "planner",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      slug: "text-failsafe",
      modelSlug: "openai/gpt-5.6-sol",
      providerOrder: ["OpenAI"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_050_000,
      maxFileBytes: 0, // text-only by default; native-file path uses a native-doc profile
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: true, // gpt-5.6-sol DOES accept file input; usable as failsafe for doc work too
      routerRole: "failsafe",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      // Independent text-tier checker: Google family ≠ OpenAI maker.
      // FAB v2 #2 (57.86%) — frontier-grade analyst audit at mid-tier cost.
      slug: "text-checker",
      modelSlug: "google/gemini-3.5-flash",
      providerOrder: ["Google"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_048_576,
      maxFileBytes: 0,
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: false,
      routerRole: "checker",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      // High-volume text maker: GPT-5.6 Luna (xHigh) — II 51 at $0.10/$0.60.
      slug: "text-maker",
      modelSlug: "openai/gpt-5.6-luna",
      providerOrder: ["OpenAI"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_048_576,
      maxFileBytes: 0,
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: false,
      routerRole: "maker",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      slug: "text-pro",
      modelSlug: "deepseek/deepseek-v4-pro",
      providerOrder: ["DeepSeek"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 1_048_576,
      maxFileBytes: 0,
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: false,
      routerRole: "maker",
      approvedFor: approvedCloud,
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    // ── Local / private escape hatch (air-gapped + restricted-mnpi) ──
    {
      slug: "local-private-default",
      modelSlug: "local/private-default",
      providerOrder: ["Local"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: false,
      contextWindowTokens: 32_000,
      maxFileBytes: 8 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: true,
      nativeFileInput: true,
      routerRole: "maker",
      approvedFor: ["public", "confidential-internal", "restricted-mnpi"],
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
  ];
}

// ─── Certification persistence ─────────────────────────────────────────
//
// `certify()` mutates the in-memory registry; without persistence every
// process restart would silently forget live contract-test passes and the
// client would fail closed forever. Certifications persist as an append-only
// JSON list; the latest entry per (profile, mime) wins, so a later "fail"
// honestly revokes an earlier "pass".

export interface PersistedCertification {
  profileSlug: string;
  modelSlug: string;
  mime: NativeMime;
  result: "pass" | "fail";
  date: string;
  /** What proved it (e.g. "code-word round-trip via file-parser native"). */
  evidence: string;
}

export function appendCertification(filePath: string, entry: PersistedCertification): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing: PersistedCertification[] = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : [];
  existing.push(entry);
  fs.writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Apply persisted certifications to a registry. The latest entry per
 * (profile, mime) wins; entries whose modelSlug no longer matches the
 * profile's current model are ignored (a swapped model must re-certify).
 */
export function loadPersistedCertifications(
  registry: ModelProfileRegistry,
  filePath: string,
): void {
  if (!fs.existsSync(filePath)) return;
  let entries: PersistedCertification[];
  try {
    entries = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return; // unreadable certifications certify nothing (fail closed)
  }
  if (!Array.isArray(entries)) return;
  const latest = new Map<string, PersistedCertification>();
  for (const e of entries) {
    if (!e?.profileSlug || !e?.mime || !e?.result) continue;
    latest.set(`${e.profileSlug} ${e.mime}`, e);
  }
  for (const e of latest.values()) {
    const profile = registry.get(e.profileSlug);
    if (!profile) continue;
    if (profile.modelSlug !== e.modelSlug) continue;
    registry.certify(e.profileSlug, e.mime, e.result);
  }
}
