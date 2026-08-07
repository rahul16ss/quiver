/**
 * CapabilityRegistry — §6.
 *
 * An immutable, versioned capability record per
 *   gateway + provider endpoint + model + runtime/version + capability.
 *
 * The brief is explicit: "Do not use one mutable lastContractTest value to
 * represent multiple MIME or capability tests." Each native-MIME test gets its
 * own CapabilityRecord with its own last-test result + evidence. Records are
 * immutable (append-only versioning); certify() produces a new record version
 * rather than mutating the old one.
 *
 * The registry is the source of truth for what a route can natively do. The
 * model client consults it to fail closed when a requested MIME is not certified
 * on a route-by-route basis (PDF passing does not certify DOCX/XLSX/PPTX).
 */

import { createHash } from "crypto";
import type { NativeMime } from "./model-profile.js";

export type Gateway = "openrouter" | "local-private";
export type ModelRole = "maker" | "checker";

export type CapabilityKind =
  | "native-mime"
  | "tool-calling"
  | "strict-structured-output"
  | "vision"
  | "context-window"
  | "concurrency"
  | "zdr-security";

/** The result of a single contract test for a single capability. */
export interface ContractTestResult {
  /** ISO timestamp of the test run. */
  date: string;
  result: "pass" | "fail" | "not-run";
  /** The runtime/engine version that was tested (e.g. "ChatOpenRouter 0.4.5"). */
  runtimeVersion: string;
  /** Optional digest of the model/weights where applicable (local models). */
  modelDigest?: string;
  /** Human-readable evidence: what was sent, what was returned. */
  evidence?: string;
  /** A reference to the recorded fixture/replay, if any. */
  fixtureRef?: string;
}

/**
 * An immutable capability record. One record per (gateway, endpoint, model,
 * runtime, capability). For native-mime, the `mime` field discriminates which
 * MIME this record certifies — so PDF and DOCX are separate records.
 */
export interface CapabilityRecord {
  readonly version: number;
  readonly gateway: Gateway;
  readonly providerEndpoint: string;
  readonly model: string;
  readonly role: ModelRole;
  readonly runtimeVersion: string;
  readonly capability: CapabilityKind;
  /** For native-mime records: which MIME this certifies. */
  readonly mime?: NativeMime;
  /** File-size limit in bytes (for native-mime). */
  readonly maxFileBytes?: number;
  /** File-count limit per request (for native-mime). */
  readonly maxFileCount?: number;
  /** Context window in tokens (for context-window records). */
  readonly contextWindowTokens?: number;
  /** Max concurrent requests (for concurrency records). */
  readonly maxConcurrency?: number;
  /** ZDR/security eligibility (for zdr-security records). */
  readonly zdrEligible?: boolean;
  readonly lastContractTest: ContractTestResult;
  /** The record this one supersedes (version n-1), if any. */
  readonly supersedes?: number;
}

/** A composite capability snapshot for a route (all its current records). */
export interface RouteCapability {
  gateway: Gateway;
  providerEndpoint: string;
  model: string;
  role: ModelRole;
  runtimeVersion: string;
  contextWindowTokens?: number;
  maxConcurrency?: number;
  zdrEligible?: boolean;
  supportsToolCalling: boolean;
  supportsStrictOutput: boolean;
  /** MIME → certified (pass) or not. Independent per MIME. */
  nativeMime: Record<string, boolean>;
  /** Max file bytes per MIME. */
  maxFileBytes: Record<string, number>;
}

export class CapabilityRegistry {
  /** Key: `${gateway}|${endpoint}|${model}|${runtime}|${capability}|${mime?}` → records (versioned) */
  private records = new Map<string, CapabilityRecord[]>();

  private key(r: {
    gateway: Gateway;
    providerEndpoint: string;
    model: string;
    runtimeVersion: string;
    capability: CapabilityKind;
    mime?: NativeMime;
  }): string {
    return [
      r.gateway,
      r.providerEndpoint,
      r.model,
      r.runtimeVersion,
      r.capability,
      r.mime ?? "",
    ].join("|");
  }

  /**
   * Record a contract-test result. Immutable: appends a new version rather than
   * mutating. Returns the new record.
   */
  record(
    input: Omit<CapabilityRecord, "version" | "supersedes"> & { supersedes?: number },
  ): CapabilityRecord {
    const k = this.key(input);
    const existing = this.records.get(k) ?? [];
    const version = existing.length + 1;
    const prev = existing[existing.length - 1];
    const rec: CapabilityRecord = {
      ...input,
      version,
      supersedes: prev?.version,
    };
    existing.push(rec);
    this.records.set(k, existing);
    return rec;
  }

  /** The latest record for a capability (or null if never tested). */
  latest(
    gateway: Gateway,
    endpoint: string,
    model: string,
    runtime: string,
    capability: CapabilityKind,
    mime?: NativeMime,
  ): CapabilityRecord | null {
    const arr = this.records.get(
      this.key({
        gateway,
        providerEndpoint: endpoint,
        model,
        runtimeVersion: runtime,
        capability,
        mime,
      }),
    );
    return arr?.[arr.length - 1] ?? null;
  }

  /** Is a route certified (last test = pass) for a native MIME? */
  isCertified(
    gateway: Gateway,
    endpoint: string,
    model: string,
    runtime: string,
    mime: NativeMime,
  ): boolean {
    const r = this.latest(gateway, endpoint, model, runtime, "native-mime", mime);
    return r?.lastContractTest.result === "pass";
  }

  /**
   * Build the composite capability snapshot for a route. A route is "capable"
   * of a native MIME only if its latest test passed — independently per MIME.
   */
  snapshot(
    gateway: Gateway,
    endpoint: string,
    model: string,
    runtime: string,
    role: ModelRole,
  ): RouteCapability {
    const nativeMime: Record<string, boolean> = {};
    const maxFileBytes: Record<string, number> = {};
    const mimes: NativeMime[] = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "image/png",
      "image/jpeg",
    ];
    for (const m of mimes) {
      const r = this.latest(gateway, endpoint, model, runtime, "native-mime", m);
      nativeMime[m] = r?.lastContractTest.result === "pass";
      if (r?.maxFileBytes) maxFileBytes[m] = r.maxFileBytes;
    }
    const ctx = this.latest(gateway, endpoint, model, runtime, "context-window");
    const conc = this.latest(gateway, endpoint, model, runtime, "concurrency");
    const zdr = this.latest(gateway, endpoint, model, runtime, "zdr-security");
    const tools = this.latest(gateway, endpoint, model, runtime, "tool-calling");
    const strict = this.latest(gateway, endpoint, model, runtime, "strict-structured-output");
    return {
      gateway,
      providerEndpoint: endpoint,
      model,
      role,
      runtimeVersion: runtime,
      contextWindowTokens: ctx?.contextWindowTokens,
      maxConcurrency: conc?.maxConcurrency,
      zdrEligible: zdr?.zdrEligible,
      supportsToolCalling: tools?.lastContractTest.result === "pass",
      supportsStrictOutput: strict?.lastContractTest.result === "pass",
      nativeMime,
      maxFileBytes,
    };
  }

  /** All records (for audit/export). Immutable copies. */
  export(): CapabilityRecord[] {
    return Array.from(this.records.values())
      .flat()
      .map((r) => ({ ...r }));
  }

  /** Hash of the full record set (for run records / tamper-evidence). */
  hash(): string {
    return createHash("sha256")
      .update(JSON.stringify(this.export().sort((a, b) => a.version - b.version)))
      .digest("hex");
  }
}
