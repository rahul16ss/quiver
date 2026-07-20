/**
 * Sensitivity Routing — US-17.17 / Build Order #7.
 *
 * Per-sensitivity model routing and MNPI redaction (SPEC §4.3).
 *
 * The sensitivity tier determines where the model call is routed:
 *   - Low: Generic research, boilerplate → cloud model (ZDR)
 *   - Mid: Analysis, redacted of identifiers → cloud model after redaction
 *   - High: Live deal model, client names → local model only
 *
 * The audit chain records which path each call took and why.
 *
 * MNPI redaction strips identifiers (client names, deal terms, company names
 * marked as confidential) from the prompt before sending to a cloud model.
 * The user sees a redaction receipt: "3 client names + 2 deal terms redacted"
 * — not a silent strip.
 *
 * Until per-sensitivity routing is fully built, the honest external phrasing
 * is: "Data handling and model use are configured around the workflow's
 * sensitivity" — configured per engagement, not enforced automatically.
 *
 * This module provides the framework. The actual routing rules and MNPI
 * patterns are configured per engagement via `.quiver/sensitivity.json`.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────

export type SensitivityTier = "low" | "mid" | "high";

export type ModelRoute = "cloud" | "cloud-redacted" | "local";

export interface RedactionRecord {
  type: string;
  original: string;
  redacted: string;
  index: number;
}

export interface SensitivityResult {
  tier: SensitivityTier;
  route: ModelRoute;
  redactions: RedactionRecord[];
  redactedText: string;
  originalText: string;
  reason: string;
}

export interface SensitivityConfig {
  /** Default sensitivity tier when no rules match */
  defaultTier: SensitivityTier;
  /** Model endpoints for each route */
  modelEndpoints: {
    cloud: string;
    local: string;
  };
  /** MNPI patterns to redact for mid-tier routing */
  mnpiPatterns: MnpiPattern[];
  /** Keywords that trigger high-sensitivity tier */
  highSensitivityKeywords: string[];
  /** Keywords that trigger mid-sensitivity tier */
  midSensitivityKeywords: string[];
}

export interface MnpiPattern {
  type: string;
  pattern: string;
  replacement: string;
}

// ─── Default config ──────────────────────────────────────────────────

const DEFAULT_CONFIG: SensitivityConfig = {
  defaultTier: "low",
  modelEndpoints: {
    cloud: "cloud",
    local: "local",
  },
  mnpiPatterns: [
    {
      type: "client_name",
      pattern: "\\b(?:Client|Customer)\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)*\\b",
      replacement: "[CLIENT_NAME]",
    },
    {
      type: "deal_term",
      pattern:
        "\\b(?:deal|transaction|acquisition|merger)\\s+(?:value|price|amount)\\s*(?:of)?\\s*\\$?[\\d,.]+(?:\\s*(?:million|billion|M|B))?",
      replacement: "[DEAL_TERM]",
    },
    {
      type: "financial_figure",
      pattern: "\\$[\\d,]+(?:\\.\\d+)?(?:\\s*(?:million|billion|M|B))?",
      replacement: "[FIGURE]",
    },
  ],
  highSensitivityKeywords: [
    "confidential",
    "mnpi",
    "material non-public",
    "live deal",
    "client name",
    "deal model",
  ],
  midSensitivityKeywords: [
    "client",
    "deal",
    "acquisition",
    "merger",
    "financial model",
    "valuation",
    "comparable",
    "transaction",
  ],
};

// ─── Core functions ──────────────────────────────────────────────────

let loadedConfig: SensitivityConfig | null = null;

/**
 * Load sensitivity config from .quiver/sensitivity.json, or use defaults.
 */
export function loadSensitivityConfig(configPath?: string): SensitivityConfig {
  const filePath =
    configPath || path.join(process.cwd(), ".quiver", "sensitivity.json");
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Get the current sensitivity config (lazy-loaded).
 */
export function getSensitivityConfig(): SensitivityConfig {
  if (!loadedConfig) {
    loadedConfig = loadSensitivityConfig();
  }
  return loadedConfig;
}

/**
 * Classify the sensitivity tier of a text based on keyword matching.
 */
export function classifySensitivity(
  text: string,
  config?: SensitivityConfig,
): { tier: SensitivityTier; reason: string } {
  const cfg = config || getSensitivityConfig();
  const lowerText = text.toLowerCase();

  // Check for high-sensitivity keywords
  for (const kw of cfg.highSensitivityKeywords) {
    if (lowerText.includes(kw.toLowerCase())) {
      return {
        tier: "high",
        reason: `Matched high-sensitivity keyword: "${kw}"`,
      };
    }
  }

  // Check for mid-sensitivity keywords
  for (const kw of cfg.midSensitivityKeywords) {
    if (lowerText.includes(kw.toLowerCase())) {
      return {
        tier: "mid",
        reason: `Matched mid-sensitivity keyword: "${kw}"`,
      };
    }
  }

  return {
    tier: cfg.defaultTier,
    reason: "No sensitivity keywords matched — default tier",
  };
}

/**
 * Redact MNPI from text. Returns the redacted text and a record of what was redacted.
 */
export function redactMnpi(
  text: string,
  config?: SensitivityConfig,
): { redactedText: string; redactions: RedactionRecord[] } {
  const cfg = config || getSensitivityConfig();
  const redactions: RedactionRecord[] = [];
  let redactedText = text;

  for (const pattern of cfg.mnpiPatterns) {
    try {
      const regex = new RegExp(pattern.pattern, "gi");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(redactedText)) !== null) {
        redactions.push({
          type: pattern.type,
          original: match[0],
          redacted: pattern.replacement,
          index: match.index,
        });
      }
      redactedText = redactedText.replace(regex, pattern.replacement);
    } catch {
      // Invalid regex — skip this pattern
    }
  }

  return { redactedText, redactions };
}

/**
 * Determine the model route based on sensitivity tier.
 */
export function routeForTier(tier: SensitivityTier): ModelRoute {
  switch (tier) {
    case "high":
      return "local";
    case "mid":
      return "cloud-redacted";
    case "low":
    default:
      return "cloud";
  }
}

/**
 * Full sensitivity routing: classify, redact if needed, determine route.
 * This is the main entry point for the agent loop.
 */
export function applySensitivityRouting(
  text: string,
  config?: SensitivityConfig,
): SensitivityResult {
  const cfg = config || getSensitivityConfig();
  const { tier, reason } = classifySensitivity(text, cfg);
  const route = routeForTier(tier);

  let redactedText = text;
  let redactions: RedactionRecord[] = [];

  if (route === "cloud-redacted") {
    const result = redactMnpi(text, cfg);
    redactedText = result.redactedText;
    redactions = result.redactions;
  }

  return {
    tier,
    route,
    redactions,
    redactedText,
    originalText: text,
    reason,
  };
}

/**
 * Format a redaction receipt for the user.
 * Example: "3 client names + 2 deal terms redacted"
 */
export function formatRedactionReceipt(redactions: RedactionRecord[]): string {
  if (redactions.length === 0) return "No redactions applied.";

  const byType: Record<string, number> = {};
  for (const r of redactions) {
    byType[r.type] = (byType[r.type] || 0) + 1;
  }

  const parts = Object.entries(byType).map(([type, count]) => {
    const label = type.replace(/_/g, " ");
    return `${count} ${label}${count === 1 ? "" : "s"}`;
  });

  return `${parts.join(" + ")} redacted`;
}

/**
 * Get the model endpoint for a given route.
 */
export function getModelEndpoint(
  route: ModelRoute,
  config?: SensitivityConfig,
): string {
  const cfg = config || getSensitivityConfig();
  return route === "local"
    ? cfg.modelEndpoints.local
    : cfg.modelEndpoints.cloud;
}
