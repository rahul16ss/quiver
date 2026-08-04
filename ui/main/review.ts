import * as path from "path";
import * as fsSync from "fs";
import { AuditChain } from "../../src/audit_chain.ts";
import { config } from "../../src/config.ts";
import { validateEvidenceFile } from "../../src/evidence/tracker.ts";
import { resolveAndAssertPathAllowed, createDefaultPolicy } from "../../src/security/path_policy.ts";
import { loadConfig } from "./config.ts";

export function reviewAuditPath(filePath: string): string {
  const dir = path.dirname(filePath || "");
  const base = (path.basename(filePath || "document") || "document").replace(/\.(docx|xlsx|pptx)$/, "");
  return path.join(dir, `${base}_Review_Audit.json`);
}

export function reviewRecordPath(filePath: string): string {
  const dir = path.dirname(filePath || "");
  const base = (path.basename(filePath || "document") || "document").replace(/\.(docx|xlsx|pptx)$/, "");
  return path.join(dir, `${base}_Review_Record.json`);
}

export async function logReviewDecision(
  filePath: string,
  openFlags: number,
  action: "marked_final" | "override",
  figureStatuses?: any,
): Promise<{ logged: boolean; blocked: boolean; action: string }> {
  const auditPath = reviewAuditPath(filePath);
  const recordPath = reviewRecordPath(filePath);
  try {
    let chain: AuditChain;
    try {
      const raw = await fsSync.promises.readFile(auditPath, "utf8");
      chain = AuditChain.deserialize(raw);
    } catch {
      chain = new AuditChain();
    }
    chain.appendEntry(
      "approval",
      JSON.stringify({
        review_decision: action,
        deliverable: filePath,
        open_flags: openFlags,
        timestamp: new Date().toISOString(),
      }),
    );
    await fsSync.promises.mkdir(path.dirname(auditPath), { recursive: true });
    await fsSync.promises.writeFile(auditPath, chain.serialize(), "utf8");
    let record: any = {};
    try {
      record = JSON.parse(await fsSync.promises.readFile(recordPath, "utf8"));
    } catch {
      record = {};
    }
    record.deliverable = filePath;
    record.open_flags = openFlags;
    record.final = action === "marked_final" ? true : Boolean(record.final) || openFlags === 0;
    if (action === "override") record.override_logged = true;
    record.last_action = action;
    record.updated_at = new Date().toISOString();
    if (Array.isArray(figureStatuses)) record.figure_checks = figureStatuses;
    await fsSync.promises.writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
    return { logged: true, blocked: false, action };
  } catch {
    return { logged: false, blocked: false, action };
  }
}

export async function validateDeliverablePath(filePath: string): Promise<string | null> {
  try {
    if (typeof filePath !== "string" || !filePath.trim()) return "No file path given.";
    const cfg = await loadConfig();
    const workspace = path.resolve(cfg.workspacePath || process.cwd());
    let real = path.resolve(filePath);
    try {
      real = fsSync.realpathSync(real);
    } catch {
      return "This file doesn't exist.";
    }
    let wsReal = workspace;
    try {
      wsReal = fsSync.realpathSync(workspace);
    } catch {}
    const rel = path.relative(wsReal, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return "Only files inside your workspace folder can be opened from here.";
    }
    resolveAndAssertPathAllowed(real, "read", createDefaultPolicy(wsReal));
    return null;
  } catch (e: any) {
    return e?.message || "This file can't be opened.";
  }
}

export async function reviewWithEvidenceGate(
  filePath: string,
  openFlags: number,
  action: "marked_final" | "override",
  figureStatuses?: any,
): Promise<{ logged: boolean; blocked: boolean; action: string; error?: string; evidencePath?: string; evidenceProblems?: string[] }> {
  const guardErr = await validateDeliverablePath(filePath);
  if (guardErr) return { logged: false, blocked: true, action: "blocked", error: guardErr };
  if (config.evidenceRequired) {
    const evidence = await validateEvidenceFile(filePath);
    if (!evidence.valid) {
      const msg = action === "marked_final"
        ? "A valid evidence package is required before marking this deliverable final."
        : "A valid evidence package is required before recording a final override.";
      return {
        logged: false,
        blocked: true,
        action: "blocked",
        error: msg,
        evidencePath: evidence.evidencePath,
        evidenceProblems: evidence.problems,
      };
    }
  }
  return logReviewDecision(filePath, openFlags, action, figureStatuses);
}

export { config as appConfig };
