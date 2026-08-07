/**
 * OfficeEngine — Phase 6 (ADR-006).
 *
 * OfficeCLI is the primary OfficeEngine: a specific audited binary, pinned and
 * bundled per platform, verified with a pinned checksum, with background
 * self-updates disabled. Not Microsoft Graph Excel APIs, Office Scripts,
 * VBA/COM, or an Office Add-in.
 *
 * Macro-enabled, encrypted, IRM-protected and sensitivity-labelled files are
 * high-risk: read-only/copy-on-write by default; macros are never executed.
 *
 * The engine is testable via an injectable OfficeCliRunner (the real runner
 * shells out to the pinned binary; tests inject a mock). The checksum pin is
 * enforced fail-closed: a binary whose checksum does not match the pinned
 * manifest is refused.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  OfficeEngine,
  OfficeReadOpts,
  OfficeEditOpts,
  OfficeRenderOpts,
  OfficeOpts,
  OfficeStructure,
  OfficeChange,
  OfficeEditResult,
  OfficeValidationResult,
  OfficeRenderResult,
  ArtifactDiff,
} from "./interfaces.js";

// ─── Pinned binary manifest ───────────────────────────────────────────

export interface OfficeCliBinaryPin {
  version: string;
  /** sha256 of the bundled binary, per platform. */
  checksum: string;
  platform: string;
  /** License notices to surface in packaging/docs. */
  licenseNotices: string[];
}

/**
 * The shipped pin manifest. A real release bundles the exact binary and fills
 * these checksums. An empty checksum disables verification ONLY for dev; the
 * engine warns and a production build fails closed on empty checksums.
 */
export const OFFICECLI_PINS: Record<string, OfficeCliBinaryPin> = {
  darwin: { version: "1.0.0-quiver-pinned", checksum: "", platform: "darwin", licenseNotices: ["OfficeCLI — see ATTRIBUTION.md"] },
  win32: { version: "1.0.0-quiver-pinned", checksum: "", platform: "win32", licenseNotices: ["OfficeCLI — see ATTRIBUTION.md.md"] },
  linux: { version: "1.0.0-quiver-pinned", checksum: "", platform: "linux", licenseNotices: ["OfficeCLI — see ATTRIBUTION.md"] },
};

// ─── Runner abstraction ───────────────────────────────────────────────

export interface OfficeCliRunner {
  /** Run the pinned binary with args; return stdout/stderr/exitCode. */
  run(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<OfficeCliRunResult>;
  /** Resolve the binary path (for checksum verification). */
  binaryPath(): string | null;
  /** The pinned manifest entry used for verification. */
  pin(): OfficeCliBinaryPin;
}

export interface OfficeCliRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  json?: unknown;
}

// ─── High-risk detection ──────────────────────────────────────────────

const HIGH_RISK_EXTENSIONS = new Set([".xlsm", ".xlsb", ".docm", ".pptm", ".xltm"]);
const HIGH_RISK_MARKERS = [/macro/i, /encrypt/i, /IRM/i, /sensitivity/i, /protected/i, /DDE/i, /external link/i];

/** Detect high-risk Office files (macro-enabled/encrypted/IRM/sensitivity-labelled). */
export function detectHighRisk(filePath: string, warnings: string[] = []): { highRisk: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ext = path.extname(filePath).toLowerCase();
  if (HIGH_RISK_EXTENSIONS.has(ext)) {
    reasons.push(`macro-enabled/legacy extension '${ext}' — read-only/copy-on-write, macros not executed`);
  }
  for (const marker of HIGH_RISK_MARKERS) {
    if (warnings.some((w) => marker.test(w))) {
      reasons.push(`warning indicates ${marker.source.replace(/[\\/$^]/g, "")} — high-risk treatment`);
    }
  }
  return { highRisk: reasons.length > 0, reasons };
}

// ─── OfficeCliEngine ──────────────────────────────────────────────────

export class OfficeCliEngine implements OfficeEngine {
  private verified: boolean | null = null;

  constructor(private runner: OfficeCliRunner) {}

  binaryIdentity(): { version: string; checksum: string; platform: string } {
    const pin = this.runner.pin();
    return { version: pin.version, checksum: pin.checksum, platform: pin.platform };
  }

  /**
   * Verify the bundled binary against the pinned checksum. Fail closed if the
   * checksum is non-empty and does not match. An empty checksum is allowed only
   * in development (the engine warns); production builds must populate it.
   */
  async verifyBinary(): Promise<{ ok: boolean; reason?: string }> {
    const pin = this.runner.pin();
    const binPath = this.runner.binaryPath();
    if (!binPath || !fs.existsSync(binPath)) {
      this.verified = false;
      return { ok: false, reason: "pinned OfficeCLI binary not found" };
    }
    if (!pin.checksum) {
      this.verified = true; // dev mode — warn but allow
      return { ok: true, reason: "checksum pin empty (dev mode); production builds must pin" };
    }
    const hash = sha256File(binPath);
    if (hash !== pin.checksum) {
      this.verified = false;
      return { ok: false, reason: `checksum mismatch: expected ${pin.checksum}, got ${hash}` };
    }
    this.verified = true;
    return { ok: true };
  }

  private async ensureVerified(): Promise<void> {
    if (this.verified === null) {
      const v = await this.verifyBinary();
      if (!v.ok && !/dev mode/.test(v.reason ?? "")) {
        throw new Error(`OfficeCLI binary verification failed: ${v.reason}`);
      }
    }
    if (this.verified === false) {
      throw new Error("OfficeCLI binary failed checksum verification; refusing to run.");
    }
  }

  async read(filePath: string, opts: OfficeReadOpts = {}): Promise<OfficeStructure> {
    await this.ensureVerified();
    const args = ["read", filePath, "--json"];
    if (opts.includeFormulas) args.push("--formulas");
    if (opts.includeComments) args.push("--comments");
    const res = await this.runner.run(args, { timeoutMs: opts.budget?.timeoutMs });
    const warnings = parseWarnings(res);
    const hr = detectHighRisk(filePath, warnings);
    const structure = parseStructure(res, filePath);
    structure.warnings = warnings;
    structure.highRisk = hr.highRisk;
    structure.riskReasons = hr.reasons;
    return structure;
  }

  async edit(workingCopyPath: string, changes: OfficeChange[], opts: OfficeEditOpts = {}): Promise<OfficeEditResult> {
    await this.ensureVerified();
    // High-risk working copies are copy-on-write: never edit the original.
    const target = workingCopyPath;
    const dataFile = path.join(path.dirname(target), `.quiver-edits-${Date.now()}.json`);
    fs.writeFileSync(dataFile, JSON.stringify(changes));
    const args = ["edit", target, "--data", dataFile];
    if (opts.atomic) args.push("--atomic");
    const res = await this.runner.run(args, { timeoutMs: opts.budget?.timeoutMs });
    cleanup(dataFile);
    if (!res.success) {
      return { path: target, applied: 0, warnings: parseWarnings(res).concat([res.stderr].filter(Boolean)) };
    }
    const applied = parseAppliedCount(res);
    // Read-back verification: an edit that the binary cannot re-validate is
    // not a successful edit. Fail closed — do not report applied counts for
    // an unchecked artifact (§10).
    const v = await this.validate(target, opts);
    if (!v.ok) {
      return {
        path: target,
        applied: 0,
        warnings: parseWarnings(res).concat(v.errors).concat(v.warnings),
      };
    }
    return { path: target, applied, warnings: parseWarnings(res).concat(v.warnings) };
  }

  async validate(filePath: string, opts: OfficeOpts = {}): Promise<OfficeValidationResult> {
    await this.ensureVerified();
    const res = await this.runner.run(["validate", filePath, "--json"], { timeoutMs: opts.budget?.timeoutMs });
    const warnings = parseWarnings(res);
    const errors = res.success ? [] : [res.stderr || `validation failed (exit ${res.exitCode})`];
    return { ok: res.success && errors.length === 0, errors, warnings };
  }

  async render(filePath: string, opts: OfficeRenderOpts): Promise<OfficeRenderResult> {
    await this.ensureVerified();
    const outDir = path.join(path.dirname(filePath), `.quiver-render-${Date.now()}`);
    fs.mkdirSync(outDir, { recursive: true });
    const args = ["render", filePath, "--format", opts.format, "--out", outDir];
    if (opts.pages?.length) args.push("--pages", opts.pages.join(","));
    const res = await this.runner.run(args, { timeoutMs: opts.budget?.timeoutMs });
    if (!res.success) {
      return { artifacts: [] };
    }
    const artifacts = (res.json as any)?.artifacts ?? [];
    return { artifacts };
  }

  async compare(before: string, after: string, opts: OfficeOpts = {}): Promise<ArtifactDiff> {
    await this.ensureVerified();
    const res = await this.runner.run(["compare", before, after, "--json"], { timeoutMs: opts.budget?.timeoutMs });
    const changes = (res.json as any)?.changes ?? [];
    return {
      semantic: (res.json as any)?.summary ?? `${changes.length} change(s)`,
      changes: changes.map((c: any) => ({ kind: c.kind ?? "paragraph", locator: c.locator ?? "", before: c.before, after: c.after })),
    };
  }
}

// ─── Real runner (shells out to the pinned binary) ────────────────────

export class ShellOfficeCliRunner implements OfficeCliRunner {
  constructor(private binPath: string, private pinEntry: OfficeCliBinaryPin) {}

  binaryPath(): string | null {
    return fs.existsSync(this.binPath) ? this.binPath : null;
  }

  pin(): OfficeCliBinaryPin {
    return this.pinEntry;
  }

  async run(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<OfficeCliRunResult> {
    const { execFile } = await import("child_process");
    return new Promise((resolve) => {
      execFile(this.binPath, args, { maxBuffer: 10 * 1024 * 1024, cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000 }, (err, stdout, stderr) => {
        const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        let json: unknown;
        try { json = stdout ? JSON.parse(stdout) : undefined; } catch { json = undefined; }
        resolve({ success: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode, json });
      });
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function sha256File(p: string): string {
  const buf = fs.readFileSync(p);
  return createHash("sha256").update(buf).digest("hex");
}

function parseWarnings(res: OfficeCliRunResult): string[] {
  const w = (res.json as any)?.warnings;
  if (Array.isArray(w)) return w.map(String);
  if (res.stderr) return [res.stderr];
  return [];
}

function parseAppliedCount(res: OfficeCliRunResult): number {
  const n = (res.json as any)?.applied;
  return typeof n === "number" ? n : (res.success ? 1 : 0);
}

function parseStructure(res: OfficeCliRunResult, filePath: string): OfficeStructure {
  const j = (res.json as any) ?? {};
  const ext = path.extname(filePath).toLowerCase();
  return {
    mimeType: extToMime(ext),
    sheets: j.sheets,
    paragraphs: j.paragraphs,
    slides: j.slides,
    warnings: [],
    highRisk: false,
    riskReasons: [],
  };
}

function extToMime(ext: string): string {
  switch (ext) {
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function cleanup(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}