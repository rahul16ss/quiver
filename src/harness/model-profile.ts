/**
 * ModelProfile — Phase 2 (ADR-001).
 *
 * Versioned, certified records of model capability. Capabilities are NOT
 * inferred from branding; they are certified with live, opt-in contract tests.
 * A profile that has not passed its contract test for a MIME type may not be
 * used for native ingestion of that MIME type — the client fails closed.
 */

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
  pick(role: "planner" | "maker" | "checker" | "reviewer", sensitivity: SensitivityProfile): ModelProfile | undefined {
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

/** Whether a profile is certified for native ingestion of a given MIME type. */
export function isCertifiedFor(profile: ModelProfile, mime: NativeMime): boolean {
  return (
    profile.testedNativeMimeTypes.includes(mime) &&
    profile.lastContractTest.result === "pass"
  );
}

/** A small shipped catalog of starter profiles (all `not-run` until certified). */
export function starterCatalog(): ModelProfile[] {
  return [
    {
      slug: "openai-gpt-4o",
      modelSlug: "openai/gpt-4o",
      providerOrder: ["OpenAI"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 128_000,
      maxFileBytes: 20 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: true,
      approvedFor: ["public", "confidential-internal"],
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
    {
      slug: "anthropic-claude-sonnet",
      modelSlug: "anthropic/claude-sonnet-4.5",
      providerOrder: ["Anthropic"],
      testedNativeMimeTypes: [],
      supportsToolCalling: true,
      supportsStrictOutput: true,
      contextWindowTokens: 200_000,
      maxFileBytes: 32 * 1024 * 1024,
      zdrEligible: true,
      checkerEligible: true,
      approvedFor: ["public", "confidential-internal"],
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
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
      approvedFor: ["public", "confidential-internal", "restricted-mnpi"],
      lastContractTest: { date: "", result: "not-run" },
      pdfEngine: "native",
    },
  ];
}