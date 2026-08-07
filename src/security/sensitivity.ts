/**
 * Sensitivity Routing — US-17.17 / Build Order #7.
 *
 * Per-sensitivity model routing and MNPI redaction (SPEC §4.3).
 *
 * The sensitivity tier determines where the model call is routed:
 *   - Low: explicitly public or synthetic work → cloud model
 *   - Mid: configured internal work → cloud model after redaction
 *   - High: confidential, client-confidential, or MNPI work → local only
 *
 * The audit chain records which path each call took and why.
 *
 * MNPI redaction strips identifiers configured for the engagement from the
 * prompt before sending to a cloud model.
 * The user sees a redaction receipt: "3 client names + 2 deal terms redacted"
 * — not a silent strip.
 *
 * There are no built-in MNPI keywords or fallback patterns. The actual
 * routing rules and redaction patterns are configured per engagement via
 * `.quiver/sensitivity.json`; missing or invalid configuration refuses the
 * turn before any model call.
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────

export type SensitivityTier = "low" | "mid" | "high";

export type ModelRoute = "cloud" | "cloud-redacted" | "local";

export type EngagementSensitivity =
  "synthetic" | "public" | "internal" | "confidential" | "client-confidential" | "mnpi" | "unknown";

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
  /** Schema version for the engagement-owned file. */
  version: 1;
  /** Explicit default tier when no configured rule matches. */
  defaultTier: SensitivityTier;
  /** Model endpoints for each route */
  modelEndpoints: {
    cloud: string;
    local: string;
  };
  /** Engagement-owned patterns to redact for mid-tier routing. */
  mnpiPatterns: MnpiPattern[];
  /** Engagement-owned regex rules that classify text. */
  classificationRules: SensitivityRule[];
}

export interface MnpiPattern {
  type: string;
  pattern: string;
  replacement: string;
}

export interface SensitivityRule {
  type: string;
  pattern: string;
  tier: SensitivityTier;
  reason?: string;
}

export class SensitivityConfigError extends Error {
  constructor(
    public readonly configPath: string,
    reason: string,
  ) {
    super(
      `Sensitivity configuration unavailable at ${configPath}: ${reason}. ` +
        "Create or repair the engagement's .quiver/sensitivity.json before continuing.",
    );
    this.name = "SensitivityConfigError";
  }
}

// ─── Core functions ──────────────────────────────────────────────────

let loadedConfig: SensitivityConfig | null = null;
let loadedConfigPath: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTier(value: unknown): value is SensitivityTier {
  return value === "low" || value === "mid" || value === "high";
}

function isEngagementSensitivity(value: unknown): value is EngagementSensitivity {
  return (
    value === "synthetic" ||
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "client-confidential" ||
    value === "mnpi" ||
    value === "unknown"
  );
}

function validateRegex(pattern: string, configPath: string, label: string): void {
  try {
    new RegExp(pattern, "gi");
  } catch (error) {
    throw new SensitivityConfigError(
      configPath,
      `${label} is not a valid regular expression: ${String(error)}`,
    );
  }
}

function parseSensitivityConfig(value: unknown, configPath: string): SensitivityConfig {
  if (!isRecord(value) || value.version !== 1) {
    throw new SensitivityConfigError(configPath, "version must be 1");
  }
  if (!isTier(value.defaultTier)) {
    throw new SensitivityConfigError(configPath, "defaultTier must be low, mid, or high");
  }

  const endpoints = value.modelEndpoints;
  if (
    !isRecord(endpoints) ||
    typeof endpoints.cloud !== "string" ||
    typeof endpoints.local !== "string"
  ) {
    throw new SensitivityConfigError(
      configPath,
      "modelEndpoints.cloud and modelEndpoints.local must be strings",
    );
  }

  if (!Array.isArray(value.mnpiPatterns)) {
    throw new SensitivityConfigError(configPath, "mnpiPatterns must be an array");
  }
  const mnpiPatterns = value.mnpiPatterns.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.type !== "string" ||
      typeof entry.pattern !== "string" ||
      typeof entry.replacement !== "string"
    ) {
      throw new SensitivityConfigError(
        configPath,
        `mnpiPatterns[${index}] must contain type, pattern, and replacement strings`,
      );
    }
    validateRegex(entry.pattern, configPath, `mnpiPatterns[${index}].pattern`);
    return {
      type: entry.type,
      pattern: entry.pattern,
      replacement: entry.replacement,
    };
  });

  if (!Array.isArray(value.classificationRules)) {
    throw new SensitivityConfigError(configPath, "classificationRules must be an array");
  }
  const classificationRules = value.classificationRules.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.type !== "string" ||
      typeof entry.pattern !== "string" ||
      !isTier(entry.tier) ||
      (entry.reason !== undefined && typeof entry.reason !== "string")
    ) {
      throw new SensitivityConfigError(
        configPath,
        `classificationRules[${index}] must contain type, pattern, and tier`,
      );
    }
    validateRegex(entry.pattern, configPath, `classificationRules[${index}].pattern`);
    return {
      type: entry.type,
      pattern: entry.pattern,
      tier: entry.tier,
      ...(entry.reason ? { reason: entry.reason } : {}),
    };
  });

  if (value.defaultTier === "mid" && mnpiPatterns.length === 0) {
    throw new SensitivityConfigError(
      configPath,
      "a mid default requires at least one redaction pattern",
    );
  }

  return {
    version: 1,
    defaultTier: value.defaultTier,
    modelEndpoints: {
      cloud: endpoints.cloud,
      local: endpoints.local,
    },
    mnpiPatterns,
    classificationRules,
  };
}

export function resolveSensitivityConfigPath(engagementRoot = process.cwd()): string {
  return path.join(engagementRoot, ".quiver", "sensitivity.json");
}

/**
 * Load the strict engagement-owned sensitivity config.
 * Missing, malformed, or unsafe configuration is an explicit refusal.
 */
export function loadSensitivityConfig(
  configPath?: string,
  engagementRoot = process.cwd(),
): SensitivityConfig {
  const filePath = configPath || resolveSensitivityConfigPath(engagementRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error: any) {
    throw new SensitivityConfigError(
      filePath,
      error?.code === "ENOENT"
        ? "file is missing"
        : `file could not be read: ${error?.message || String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SensitivityConfigError(filePath, `JSON could not be parsed: ${String(error)}`);
  }
  return parseSensitivityConfig(parsed, filePath);
}

/**
 * Get the current sensitivity config (lazy-loaded per engagement path).
 */
export function getSensitivityConfig(engagementRoot = process.cwd()): SensitivityConfig {
  const configPath = resolveSensitivityConfigPath(engagementRoot);
  if (!loadedConfig || loadedConfigPath !== configPath) {
    loadedConfig = loadSensitivityConfig(configPath);
    loadedConfigPath = configPath;
  }
  return loadedConfig;
}

/** Clear the lazy cache after an engagement config changes. */
export function resetSensitivityConfigCache(): void {
  loadedConfig = null;
  loadedConfigPath = null;
}

function tierForEngagement(engagement: EngagementSensitivity): {
  tier: SensitivityTier;
  reason: string;
} {
  switch (engagement) {
    case "synthetic":
    case "public":
      return {
        tier: "low",
        reason: `Explicit engagement classification: ${engagement}`,
      };
    case "internal":
      return {
        tier: "mid",
        reason: "Explicit engagement classification: internal",
      };
    case "confidential":
    case "client-confidential":
    case "mnpi":
    case "unknown":
      return {
        tier: "high",
        reason: `Explicit engagement classification: ${engagement}`,
      };
  }
}

/**
 * Classify sensitivity from explicit engagement metadata and configured
 * regex rules. No source-code keywords are used.
 */
export function classifySensitivity(
  text: string,
  config?: SensitivityConfig,
  engagement?: EngagementSensitivity,
): { tier: SensitivityTier; reason: string } {
  const cfg = config || getSensitivityConfig();
  if (engagement && isEngagementSensitivity(engagement)) {
    return tierForEngagement(engagement);
  }

  const matches = cfg.classificationRules
    .filter((rule) => new RegExp(rule.pattern, "i").test(text))
    .sort((a, b) => {
      const priority = { high: 3, mid: 2, low: 1 };
      return priority[b.tier] - priority[a.tier];
    });
  const match = matches[0];
  if (match) {
    return {
      tier: match.tier,
      reason: match.reason || `Matched configured sensitivity rule: ${match.type}`,
    };
  }

  return {
    tier: cfg.defaultTier,
    reason: "No configured sensitivity rule matched — explicit engagement default",
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
  let workingText = text;

  for (const pattern of cfg.mnpiPatterns) {
    // Use separate regex instances for exec and replace to avoid lastIndex
    // state contamination between the two passes. Config loading validates
    // every expression; a direct caller with an invalid config must still
    // fail closed rather than silently skip the rule.
    const execRegex = new RegExp(pattern.pattern, "gi");
    const replaceRegex = new RegExp(pattern.pattern, "gi");
    let match: RegExpExecArray | null;
    // Collect redaction records from the CURRENT text state (which may
    // already have been modified by prior patterns). Indices are relative
    // to the text at this point in the pipeline.
    while ((match = execRegex.exec(workingText)) !== null) {
      redactions.push({
        type: pattern.type,
        original: match[0],
        redacted: pattern.replacement,
        index: match.index,
      });
      // Prevent infinite loop on zero-length matches
      if (match.index === execRegex.lastIndex) execRegex.lastIndex++;
    }
    workingText = workingText.replace(replaceRegex, pattern.replacement);
  }

  return { redactedText: workingText, redactions };
}

/**
 * Redact every textual part of a model message without changing images or
 * other structured payloads. This is used for system, user, tool, and
 * assistant context before a cloud-redacted call.
 */
export function redactMessageContent(content: unknown, config?: SensitivityConfig): unknown {
  if (typeof content === "string") {
    return redactMnpi(content, config).redactedText;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return {
          ...(part as Record<string, unknown>),
          text: redactMnpi((part as { text: string }).text, config).redactedText,
        };
      }
      return part;
    });
  }
  return content;
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
  engagement?: EngagementSensitivity,
): SensitivityResult {
  const cfg = config || getSensitivityConfig();
  const { tier, reason } = classifySensitivity(text, cfg, engagement);
  const route = routeForTier(tier);

  let redactedText = text;
  let redactions: RedactionRecord[] = [];

  if (route === "cloud-redacted") {
    if (cfg.mnpiPatterns.length === 0) {
      throw new SensitivityConfigError(
        loadedConfigPath || "<provided config>",
        "cloud-redacted routing requires configured redaction patterns",
      );
    }
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
export function getModelEndpoint(route: ModelRoute, config?: SensitivityConfig): string {
  const cfg = config || getSensitivityConfig();
  return route === "local" ? cfg.modelEndpoints.local : cfg.modelEndpoints.cloud;
}
