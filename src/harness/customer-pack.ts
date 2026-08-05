/**
 * CustomerPack — Phase 1 (ADR-004).
 *
 * A CustomerPack is data/configuration, not a code fork. It carries a
 * customer's house terminology, templates, source-precedence, approved models/
 * providers, sensitivity profiles, storage connectors, data-vendor entitlements,
 * allowed tools/domains, reviewer roles, prompt modules, workflow specs,
 * evaluation fixtures, and memory scopes/retention. It is versioned, diffable,
 * exportable, importable and rollbackable. It NEVER contains secrets.
 *
 * This module defines the schema + a validator that fails closed on secrets and
 * on unknown required fields. Concrete loading/diff/export is implemented here;
 * the registry is small and explicit (no DI framework).
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ─── Schema ───────────────────────────────────────────────────────────

export interface CustomerPack {
  schemaVersion: 1;
  id: string;
  version: string;
  label: string;
  /** Human-readable description (safe to log). */
  description: string;

  /** House terminology and style. */
  terminology: Record<string, string>;
  style: {
    voice?: string;
    bannedPhrases?: string[];
    currency?: string;
    units?: string;
  };

  /** Templates and prior examples (paths relative to pack root, or inline). */
  templates: Array<{ id: string; name: string; path?: string; inline?: string }>;
  examples: Array<{ id: string; name: string; path?: string; inline?: string }>;

  /** Source-precedence rules (higher wins on contradiction). */
  sourcePrecedence: Array<{ category: string; rank: number; note?: string }>;

  /** Approved models and providers (slugs reference ModelProfile records). */
  approvedModels: Array<{
    profileSlug: string;
    roles: Array<"planner" | "maker" | "checker" | "reviewer">;
    providerOrder: string[];
  }>;

  /** Sensitivity profiles the customer recognizes. */
  sensitivityProfiles: Array<{
    name: "public" | "confidential-internal" | "restricted-mnpi";
    parallelAllowed: boolean;
    /** For confidential-internal: Parallel may receive only sanitized public queries. */
    parallelSanitizedOnly?: boolean;
    cloudInferenceAllowed: boolean;
    /** Approved local/private route slug for restricted-mnpi. */
    localRouteSlug?: string;
  }>;

  /** Storage connectors (by StorageProvider id). */
  storageConnectors: Array<{
    providerId: string;
    kind: "local" | "microsoft-graph" | "google-drive";
    /** Reference to a connector config; secrets live in the OS credential store. */
    configRef: string;
    roots?: string[];
  }>;

  /** Data-vendor entitlements (connector names entitled to run). */
  dataVendorEntitlements: Array<{
    connector: string;
    datasets: string[];
    redistributionAllowed: boolean;
    cacheExpirySeconds?: number;
  }>;

  /** Allowed tools and domains. */
  allowedTools: string[];
  allowedDomains: string[];

  /** Reviewer roles and approval thresholds. */
  reviewers: Array<{
    role: string;
    approvalThreshold: "single" | "dual" | "committee";
    canCommit: boolean;
  }>;

  /** Prompt modules (named fragments referenced by the PromptCompiler). */
  promptModules: Record<string, string>;

  /** Workflow specifications (ids of WorkflowSpecs shipped with the pack). */
  workflowSpecs: string[];

  /** Evaluation fixtures (synthetic/public). */
  evaluationFixtures: Array<{ id: string; path: string }>;

  /** Memory scopes and retention rules. */
  memory: {
    scopes: Array<"customer" | "team" | "user" | "project" | "workflow">;
    retentionDays: number;
    autoPromote: false; // harvested memory is never auto-promoted without review
  };

  /** Optional: explicitly approved local/private model route for restricted data. */
  localPrivateRoute?: {
    modelSlug: string;
    endpoint: string;
    /** Reference to credential in OS store; never the key itself. */
    credentialRef: string;
  };
}

// ─── Validation ───────────────────────────────────────────────────────

export interface PackValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Secret-like field names that must never appear in a pack. */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /bearer/i,
  /refresh[_-]?token/i,
  /client[_-]?secret/i,
];

const SCHEMA_REQUIRED_TOP_KEYS: Array<keyof CustomerPack> = [
  "schemaVersion",
  "id",
  "version",
  "label",
  "description",
  "terminology",
  "sourcePrecedence",
  "approvedModels",
  "sensitivityProfiles",
  "storageConnectors",
  "allowedTools",
  "reviewers",
  "promptModules",
  "workflowSpecs",
  "memory",
];

/**
 * Validate a CustomerPack object. Fails closed on:
 *  - missing required top-level keys
 *  - schemaVersion != 1
 *  - any secret-like key present anywhere in the object
 *  - memory.autoPromote === true (harvested memory must never auto-promote)
 *  - a restricted-mnpi profile without a local route and with cloud inference
 *    allowed (would violate fail-closed).
 */
export function validateCustomerPack(raw: unknown): PackValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["CustomerPack must be an object."], warnings };
  }
  const pack = raw as Record<string, unknown>;

  for (const key of SCHEMA_REQUIRED_TOP_KEYS) {
    if (!(key in pack)) errors.push(`Missing required field: ${String(key)}`);
  }

  if (pack.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1 (got ${String(pack.schemaVersion)}).`);
  }

  if (pack.memory && typeof pack.memory === "object") {
    const mem = pack.memory as Record<string, unknown>;
    if (mem.autoPromote === true) {
      errors.push("memory.autoPromote must be false — harvested memory requires review.");
    }
  }

  // Secret scan — recursive over the whole object.
  const foundSecrets = scanForSecrets(pack, "");
  for (const s of foundSecrets) {
    errors.push(`Secret-like field present in pack (forbidden): ${s}`);
  }

  // Restricted/MNPI must fail closed.
  if (Array.isArray(pack.sensitivityProfiles)) {
    for (const sp of pack.sensitivityProfiles) {
      if (sp && typeof sp === "object") {
        const p = sp as Record<string, unknown>;
        if (p.name === "restricted-mnpi") {
          if (p.cloudInferenceAllowed === true && !p.localRouteSlug) {
            errors.push(
              "restricted-mnpi profile allows cloud inference without a local route — must fail closed.",
            );
          }
          if (p.parallelAllowed === true) {
            errors.push("restricted-mnpi profile must not allow Parallel.");
          }
        }
      }
    }
  }

  // Approved models must reference profiles with provider order.
  if (Array.isArray(pack.approvedModels)) {
    for (const m of pack.approvedModels) {
      if (m && typeof m === "object") {
        const mm = m as Record<string, unknown>;
        if (!Array.isArray(mm.providerOrder) || mm.providerOrder.length === 0) {
          warnings.push(`approvedModels entry ${String(mm.profileSlug)} has no providerOrder.`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function scanForSecrets(obj: unknown, prefix: string): string[] {
  const found: string[] = [];
  if (obj === null || obj === undefined) return found;
  if (typeof obj !== "object") return found;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEY_PATTERNS.some((re) => re.test(key))) {
      found.push(path);
    }
    if (value && typeof value === "object") {
      found.push(...scanForSecrets(value, path));
    }
  }
  return found;
}

// ─── Versioning / hash / diff ─────────────────────────────────────────

/** Content-addressed version of a pack (deterministic JSON hash). */
export function packHash(pack: CustomerPack): string {
  const canonical = JSON.stringify(
    {
      ...pack,
      // description/label do not affect behavior; include for completeness.
    },
    Object.keys(pack).sort(),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export interface PackDiff {
  added: string[];
  removed: string[];
  changed: Array<{ path: string; before: unknown; after: unknown }>;
}

/** Structural diff between two packs (by top-level + nested paths). */
export function diffPacks(before: CustomerPack, after: CustomerPack): PackDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ path: string; before: unknown; after: unknown }> = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    const b = (before as unknown as Record<string, unknown>)[key];
    const a = (after as unknown as Record<string, unknown>)[key];
    if (b === undefined && a !== undefined) added.push(key);
    else if (b !== undefined && a === undefined) removed.push(key);
    else if (JSON.stringify(b) !== JSON.stringify(a)) changed.push({ path: key, before: b, after: a });
  }
  return { added, removed, changed };
}

// ─── Registry (small, explicit) ───────────────────────────────────────

export interface PackRecord {
  pack: CustomerPack;
  hash: string;
  loadedAt: string;
  filePath: string;
}

export class CustomerPackRegistry {
  private packs = new Map<string, PackRecord>();
  private history: PackRecord[] = [];

  /** Load + validate a pack from a JSON file. Throws on invalid pack. */
  loadFromFile(filePath: string): PackRecord {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const result = validateCustomerPack(parsed);
    if (!result.valid) {
      throw new Error(`Invalid CustomerPack at ${filePath}:\n${result.errors.join("\n")}`);
    }
    const pack = parsed as CustomerPack;
    const record: PackRecord = {
      pack,
      hash: packHash(pack),
      loadedAt: new Date().toISOString(),
      filePath,
    };
    this.packs.set(pack.id, record);
    this.history.push(record);
    return record;
  }

  get(id: string): PackRecord | undefined {
    return this.packs.get(id);
  }

  list(): PackRecord[] {
    return Array.from(this.packs.values());
  }

  /** Export a pack to JSON (never includes secrets — validation guarantees this). */
  exportPack(id: string): string {
    const rec = this.packs.get(id);
    if (!rec) throw new Error(`Pack '${id}' not found.`);
    return JSON.stringify(rec.pack, null, 2);
  }

  /** Roll back to a previously loaded version of a pack by hash. */
  rollback(id: string, hash: string): PackRecord | undefined {
    const target = this.history.find((r) => r.pack.id === id && r.hash === hash);
    if (target) this.packs.set(id, target);
    return target;
  }

  /** History of loaded versions for a pack id (for diff/rollback). */
  versions(id: string): PackRecord[] {
    return this.history.filter((r) => r.pack.id === id);
  }
}

/** Resolve a pack-relative path against a pack root directory. */
export function resolvePackPath(packRoot: string, rel: string): string {
  return path.resolve(packRoot, rel);
}

/** A minimal, valid example pack for tests and onboarding. */
export function emptyPack(overrides: Partial<CustomerPack> = {}): CustomerPack {
  return {
    schemaVersion: 1,
    id: overrides.id ?? "default",
    version: overrides.version ?? "0.1.0",
    label: overrides.label ?? "Default pack",
    description: overrides.description ?? "Minimal valid customer pack.",
    terminology: overrides.terminology ?? {},
    style: overrides.style ?? {},
    templates: overrides.templates ?? [],
    examples: overrides.examples ?? [],
    sourcePrecedence: overrides.sourcePrecedence ?? [],
    approvedModels: overrides.approvedModels ?? [],
    sensitivityProfiles: overrides.sensitivityProfiles ?? [
      { name: "public", parallelAllowed: true, cloudInferenceAllowed: true },
      {
        name: "confidential-internal",
        parallelAllowed: true,
        parallelSanitizedOnly: true,
        cloudInferenceAllowed: true,
      },
      {
        name: "restricted-mnpi",
        parallelAllowed: false,
        cloudInferenceAllowed: false,
        localRouteSlug: "local-private-default",
      },
    ],
    storageConnectors: overrides.storageConnectors ?? [],
    dataVendorEntitlements: overrides.dataVendorEntitlements ?? [],
    allowedTools: overrides.allowedTools ?? [],
    allowedDomains: overrides.allowedDomains ?? [],
    reviewers: overrides.reviewers ?? [],
    promptModules: overrides.promptModules ?? {},
    workflowSpecs: overrides.workflowSpecs ?? [],
    evaluationFixtures: overrides.evaluationFixtures ?? [],
    memory: overrides.memory ?? {
      scopes: ["customer", "team", "user", "project", "workflow"],
      retentionDays: 90,
      autoPromote: false,
    },
    localPrivateRoute: overrides.localPrivateRoute,
  };
}