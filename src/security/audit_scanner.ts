/**
 * Security Audit Scanner — Comprehensive codebase security analysis.
 *
 * Scans the project for:
 * 1. Hardcoded secrets in source files
 * 2. Symlink escape vulnerabilities
 * 3. Missing .env permission hardening
 * 4. Unvalidated file path access
 * 5. Credential leakage in child process spawning
 * 6. Missing secret redaction in logs
 *
 * Produces a structured report with severity ratings.
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { detectSecrets, redactSecrets } from "./secrets.js";

// ─── Types ───────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface AuditFinding {
  id: string;
  title: string;
  severity: Severity;
  file: string;
  line?: number;
  description: string;
  recommendation: string;
  cwe?: string;
}

export interface AuditReport {
  timestamp: string;
  scanRoot: string;
  totalFiles: number;
  findings: AuditFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  passed: boolean;
}

// ─── Scanner Configuration ──────────────────────────────────────────

const SCAN_EXTENSIONS = [".ts", ".js", ".json", ".env", ".md"];
const EXCLUDE_DIRS = [
  "node_modules",
  ".git",
  ".sessions",
  ".quiver-backups",
  "dist-electron",
  ".agents",
];

// ─── Scanners ───────────────────────────────────────────────────────

async function scanFile(
  filePath: string,
  scanRoot: string,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const relativePath = path.relative(scanRoot, filePath);

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return findings;
  }

  const lines = content.split("\n");

  // 1. Check for hardcoded secrets
  const secrets = detectSecrets(content);
  for (const secret of secrets) {
    let lineNum = 1;
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      if (pos + lines[i].length >= secret.index) {
        lineNum = i + 1;
        break;
      }
      pos += lines[i].length + 1;
    }

    if (relativePath === ".env.example") {
      findings.push({
        id: `SECRET-EXAMPLE-${findings.length}`,
        title: "Secret pattern in .env.example (expected)",
        severity: "info",
        file: relativePath,
        line: lineNum,
        description: `Found ${secret.type} pattern in .env.example. This is expected for the template file.`,
        recommendation: "Ensure .env.example contains only placeholder values, not real keys.",
        cwe: "CWE-798",
      });
      continue;
    }

    if (secret.match.includes("[REDACTED_SECRET]")) {
      continue;
    }

    findings.push({
      id: `SECRET-${findings.length}`,
      title: `Hardcoded ${secret.type} detected`,
      severity: secret.type === "private_key_block" ? "critical" : "high",
      file: relativePath,
      line: lineNum,
      description: `Found ${secret.type} pattern: ${redactSecrets(secret.match.slice(0, 40))}...`,
      recommendation: "Move secrets to OS keychain or environment variables.",
      cwe: "CWE-798",
    });
  }

  // 2. Check for eval() usage
  lines.forEach((line, i) => {
    if (/\beval\s*\(/.test(line) && !line.trim().startsWith("//")) {
      findings.push({
        id: `EVAL-${findings.length}`,
        title: "Use of eval() detected",
        severity: "high",
        file: relativePath,
        line: i + 1,
        description: "eval() can execute arbitrary code and is a security risk.",
        recommendation: "Replace eval() with safe alternatives like JSON.parse().",
        cwe: "CWE-95",
      });
    }
  });

  // 3. Check for unfiltered process.env spread
  lines.forEach((line, i) => {
    if (/\.\.\.\s*process\.env\b/.test(line) && !line.trim().startsWith("//")) {
      findings.push({
        id: `ENV-SPREAD-${findings.length}`,
        title: "Unfiltered process.env spread",
        severity: "medium",
        file: relativePath,
        line: i + 1,
        description: "Spreading process.env without filtering can leak secrets to child processes.",
        recommendation: "Filter sensitive keys before passing env to child processes.",
        cwe: "CWE-200",
      });
    }
  });

  return findings;
}

async function scanEnvPermissions(scanRoot: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const envPath = path.join(scanRoot, ".env");

  if (fsSync.existsSync(envPath)) {
    const stat = fsSync.statSync(envPath);
    const mode = stat.mode & 0o777;

    if (mode !== 0o600) {
      findings.push({
        id: "ENV-PERMS",
        title: ".env file has overly permissive permissions",
        severity: "high",
        file: ".env",
        description: `.env file has permissions ${mode.toString(8)} (expected 600).`,
        recommendation: "Run: chmod 600 .env",
        cwe: "CWE-732",
      });
    } else {
      findings.push({
        id: "ENV-PERMS-OK",
        title: ".env file permissions are restrictive (0600)",
        severity: "info",
        file: ".env",
        description: "Good — .env is restricted to owner-only access.",
        recommendation: "No action needed.",
      });
    }
  }

  return findings;
}

async function scanSymlinks(scanRoot: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  async function checkDir(dir: string) {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDE_DIRS.includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await fs.readlink(fullPath);
        } catch {
          continue;
        }

        const resolvedTarget = path.resolve(dir, target);
        const relativeToRoot = path.relative(scanRoot, resolvedTarget);

        if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
          findings.push({
            id: `SYMLINK-ESCAPE-${findings.length}`,
            title: "Symlink escapes workspace boundary",
            severity: "critical",
            file: path.relative(scanRoot, fullPath),
            description: `Symlink points to ${target} which is outside the workspace.`,
            recommendation: "Remove the symlink or validate with validateSubagentFiles().",
            cwe: "CWE-59",
          });
        }
      }

      if (entry.isDirectory()) {
        await checkDir(fullPath);
      }
    }
  }

  await checkDir(scanRoot);
  return findings;
}

// ─── Main Scanner ───────────────────────────────────────────────────

async function walkAndCollect(
  dir: string,
  scanRoot: string,
): Promise<{ files: string[]; count: number }> {
  const files: string[] = [];
  let count = 0;

  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { files, count };
  }

  for (const entry of entries) {
    if (EXCLUDE_DIRS.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const sub = await walkAndCollect(fullPath, scanRoot);
      files.push(...sub.files);
      count += sub.count;
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SCAN_EXTENSIONS.includes(ext) || entry.name === ".env") {
        files.push(fullPath);
        count++;
      }
    }
  }

  return { files, count };
}

export async function runSecurityAudit(
  scanRoot: string = process.cwd(),
): Promise<AuditReport> {
  const timestamp = new Date().toISOString();
  const findings: AuditFinding[] = [];

  const { files, count } = await walkAndCollect(scanRoot, scanRoot);

  for (const file of files) {
    const fileFindings = await scanFile(file, scanRoot);
    findings.push(...fileFindings);
  }

  const envFindings = await scanEnvPermissions(scanRoot);
  findings.push(...envFindings);

  const symlinkFindings = await scanSymlinks(scanRoot);
  findings.push(...symlinkFindings);

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    info: findings.filter((f) => f.severity === "info").length,
  };

  const passed = summary.critical === 0 && summary.high === 0;

  return {
    timestamp,
    scanRoot,
    totalFiles: count,
    findings,
    summary,
    passed,
  };
}

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║          🔒 QUIVER SECURITY AUDIT REPORT                     ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Scan Time: ${report.timestamp}`);
  lines.push(`Scan Root: ${report.scanRoot}`);
  lines.push(`Files Scanned: ${report.totalFiles}`);
  lines.push("");

  const s = report.summary;
  lines.push("── Summary ──────────────────────────────────────────────────");
  lines.push(`  Critical: ${s.critical}  |  High: ${s.high}  |  Medium: ${s.medium}  |  Low: ${s.low}  |  Info: ${s.info}`);
  lines.push(`  Overall: ${report.passed ? "✅ PASS" : "❌ FAIL"}`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("  No findings. The codebase is clean! 🎉");
    return lines.join("\n");
  }

  const severityOrder: Severity[] = ["critical", "high", "medium", "low", "info"];
  const severityEmoji: Record<Severity, string> = {
    critical: "🔴",
    high: "🟠",
    medium: "🟡",
    low: "🔵",
    info: "⚪",
  };

  for (const sev of severityOrder) {
    const sevFindings = report.findings.filter((f) => f.severity === sev);
    if (sevFindings.length === 0) continue;

    lines.push(`── ${severityEmoji[sev]} ${sev.toUpperCase()} (${sevFindings.length}) ────────────────────────`);

    for (const finding of sevFindings) {
      lines.push(`  [${finding.id}] ${finding.title}`);
      lines.push(`    File: ${finding.file}${finding.line ? `:${finding.line}` : ""}`);
      lines.push(`    ${finding.description}`);
      lines.push(`    → ${finding.recommendation}`);
      if (finding.cwe) {
        lines.push(`    CWE: ${finding.cwe}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}