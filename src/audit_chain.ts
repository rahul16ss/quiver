/**
 * Tamper-evident Audit Chain — US-9.5 / SPEC §11.3.
 *
 *   H_n = SHA-256(H_{n-1} + action_payload)
 *
 * Every action (command, file mutation, tool call, approval, evidence
 * provenance) appends a hash. Any manual alteration of the chain breaks
 * verification.
 *
 * Provenance integrity (SPEC §16 / §11.3 / §7.5): when an entry carries
 * provenance fields (source_ids / source_refs / context_used / evidence_ref),
 * those fields are a *cached copy* of values embedded in the hash-covered
 * `action_payload`. `verifyChain()` confirms the cache matches the payload,
 * so a reviewer reading `entry.source_ids` can trust it — tampering with the
 * convenience field (while leaving the payload intact) is detected just like
 * tampering with the payload itself.
 *
 * This module is the single source of truth for the chain. `src/logger.ts`
 * re-exports `AuditChain`/`AuditEntry` for backwards-compatible imports
 * (`import { AuditChain } from "../src/logger.js"`).
 */

import * as crypto from "crypto";
import { redactSecrets } from "./security/secrets.ts";

export interface AuditEntry {
  seq: number;
  timestamp: string;
  action_type:
    | "file_read"
    | "file_write"
    | "command_exec"
    | "tool_call"
    | "approval"
    | "session_start"
    | "session_end"
    | "sync_conflict"
    | "sync_cleanup"
    | "evidence";
  action_payload: string;
  hash: string;
  prev_hash: string;
  // ─── Provenance fields (SPEC §16 / §11.3 / §7.5) ────────────────────
  // A cached copy of values embedded in `action_payload`. `verifyChain`
  // confirms these match the payload, so they are tamper-evident without
  // being separately hashed.
  source_ids?: string[];      // evidence source IDs referenced in this entry
  source_refs?: string[];     // file paths / URLs / cell references for sources
  context_used?: string;      // summary of context that informed this action
  provenance?: string;        // human-readable provenance description
  evidence_ref?: string;      // path to Evidence.json if this entry has lineage
}

export class AuditChain {
  private chain: AuditEntry[] = [];
  private currentHash: string = "0".repeat(64); // Genesis hash

  constructor() {
    // Genesis entry
    this.appendEntry("session_start", "session initialized");
  }

  /**
   * Append an action to the audit chain.
   * H_n = SHA-256(H_{n-1} + action_payload)
   *
   * The payload is redacted of secrets before hashing, so secrets never
   * enter the chain (US-9.3).
   */
  appendEntry(actionType: AuditEntry["action_type"], payload: string): AuditEntry {
    const redactedPayload = redactSecrets(payload);
    const seq = this.chain.length;
    const prevHash = this.currentHash;
    const hash = crypto
      .createHash("sha256")
      .update(prevHash + redactedPayload)
      .digest("hex");

    const entry: AuditEntry = {
      seq,
      timestamp: new Date().toISOString(),
      action_type: actionType,
      action_payload: redactedPayload,
      hash,
      prev_hash: prevHash,
    };

    this.chain.push(entry);
    this.currentHash = hash;
    return entry;
  }

  /**
   * Verify the integrity of the audit chain.
   * Returns true iff every hash is consistent AND every provenance
   * convenience field matches its (hash-covered) payload.
   */
  verifyChain(): boolean {
    let expectedPrevHash = "0".repeat(64);

    for (const entry of this.chain) {
      if (entry.prev_hash !== expectedPrevHash) return false;

      const computedHash = crypto
        .createHash("sha256")
        .update(entry.prev_hash + entry.action_payload)
        .digest("hex");

      if (entry.hash !== computedHash) return false;
      expectedPrevHash = entry.hash;

      // ── Provenance field integrity (SPEC §11.3 tamper-evidence) ──
      // If the entry caches provenance fields, they must match the values
      // embedded in the hash-covered action_payload. A reviewer trusts
      // entry.source_ids only because altering it (while keeping the
      // payload intact) breaks verification here.
      if (
        entry.source_ids !== undefined ||
        entry.source_refs !== undefined ||
        entry.context_used !== undefined ||
        entry.evidence_ref !== undefined
      ) {
        let parsed: any = null;
        try {
          parsed = JSON.parse(entry.action_payload);
        } catch {
          // Payload isn't JSON — but provenance fields are present, so the
          // cache cannot match → tamper detected.
          return false;
        }
        if (parsed === null || typeof parsed !== "object") return false;
        if (
          entry.source_ids !== undefined &&
          JSON.stringify(entry.source_ids) !== JSON.stringify(parsed.source_ids)
        )
          return false;
        if (
          entry.source_refs !== undefined &&
          JSON.stringify(entry.source_refs) !== JSON.stringify(parsed.source_refs)
        )
          return false;
        if (
          entry.context_used !== undefined &&
          entry.context_used !== parsed.context_used
        )
          return false;
        if (
          entry.evidence_ref !== undefined &&
          entry.evidence_ref !== parsed.evidence_ref
        )
          return false;
      }
    }

    return true;
  }

  /**
   * Get all audit entries.
   */
  getEntries(): AuditEntry[] {
    return [...this.chain];
  }

  /**
   * Get the current (latest) hash.
   */
  getCurrentHash(): string {
    return this.currentHash;
  }

  /**
   * Serialize the chain to JSON for persistence.
   */
  serialize(): string {
    return JSON.stringify(this.chain, null, 2);
  }

  /**
   * Deserialize a chain from JSON.
   */
  static deserialize(data: string): AuditChain {
    const chain = new AuditChain();
    try {
      const entries = JSON.parse(data) as AuditEntry[];
      chain.chain = entries;
      if (entries.length > 0) {
        chain.currentHash = entries[entries.length - 1].hash;
      }
    } catch {
      // Invalid data — start fresh
    }
    return chain;
  }
}