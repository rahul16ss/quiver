/**
 * Memory Privacy Labels — US-12.3
 *
 * Support labels: public, project, private, secret.
 * - public: safe for remote models & cloud sync
 * - project: allowed for project-specific approved models
 * - private: sent to remote models only with explicit opt-in
 * - secret: never sent to remote models, never synced
 */

import type { MemoryPrivacy } from "./schema.js";
import type { MemoryFact } from "./schema.js";

// ─── Privacy Filtering ───────────────────────────────────────────────

export interface PrivacyFilterOptions {
  /** Whether remote providers are in use (vs local-only) */
  isRemote: boolean;
  /** Whether the user has opted in to sending private memories to remote */
  includePrivate: boolean;
  /** Whether to include project-scoped memories */
  includeProject: boolean;
}

/**
 * Filter memory facts based on privacy labels and provider context.
 *
 * @param facts - All memory facts
 * @param options - Privacy filter options
 * @returns Filtered facts that are safe to include in context
 */
export function filterByPrivacy(
  facts: MemoryFact[],
  options: PrivacyFilterOptions,
): MemoryFact[] {
  return facts.filter((fact) => {
    switch (fact.privacy) {
      case "public":
        // Always safe to include
        return true;

      case "project":
        // Only include if project scope is enabled
        return options.includeProject;

      case "private":
        // Only include if user explicitly opted in AND we're not sending to remote
        // OR if we're local-only (no privacy concern)
        if (!options.isRemote) return true;
        return options.includePrivate;

      case "secret":
        // Never sent to remote models, never synced
        return !options.isRemote;

      default:
        return false;
    }
  });
}

/**
 * Get the privacy label description for display.
 */
export function getPrivacyDescription(privacy: MemoryPrivacy): string {
  switch (privacy) {
    case "public":
      return "Safe for remote models and cloud sync";
    case "project":
      return "Project-scoped — only for approved models";
    case "private":
      return "Private — only sent to remote with explicit opt-in";
    case "secret":
      return "Secret — never sent to remote, never synced";
    default:
      return "Unknown privacy level";
  }
}

/**
 * Check if a privacy level is safe for sync.
 */
export function isSafeForSync(privacy: MemoryPrivacy): boolean {
  return privacy === "public" || privacy === "project";
}

/**
 * Check if a privacy level is safe for remote providers.
 */
export function isSafeForRemote(privacy: MemoryPrivacy, includePrivate: boolean): boolean {
  if (privacy === "public") return true;
  if (privacy === "project") return true;
  if (privacy === "private") return includePrivate;
  return false; // secret
}

/**
 * Format privacy labels for CLI display.
 */
export function formatPrivacyLabel(privacy: MemoryPrivacy): string {
  const labels: Record<MemoryPrivacy, string> = {
    public: "[public]",
    project: "[project]",
    private: "[private]",
    secret: "[secret]",
  };
  return labels[privacy] || "[unknown]";
}