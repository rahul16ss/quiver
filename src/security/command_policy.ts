/**
 * Shell Command Security Risk Classification — US-6.2
 *
 * Parses shell command strings and classifies them into risk bands.
 * Destructive, privileged, network, and exfiltration risks always block
 * for manual user confirmation.
 *
 * Approvals are tied to specific command hash and working directory.
 */

import * as crypto from "crypto";
import * as path from "path";

// ─── Types ───────────────────────────────────────────────────────────

export type RiskBand =
  | "safe"
  | "moderate"
  | "network"
  | "destructive"
  | "privileged"
  | "secret-risk"
  | "exfiltration-risk";

export interface CommandClassification {
  risk: RiskBand;
  reason: string;
  requiresApproval: boolean;
  hash: string;
}

// ─── Risk Patterns ───────────────────────────────────────────────────

interface RiskPattern {
  band: RiskBand;
  patterns: RegExp[];
  reason: string;
}

const RISK_PATTERNS: RiskPattern[] = [
  {
    band: "destructive",
    patterns: [
      /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)/i,
      /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/i,
      /\bgit\s+reset\s+--hard\b/i,
      /\bgit\s+clean\s+-[a-zA-Z]*f/i,
      /\bdd\s+if=/i,
      /\bmkfs\b/i,
      /\bshred\b/i,
      /\btruncate\s+-s\s+0\b/i,
      /\b:\(\)\s*\{.*\|\s*\&\s*\}/i, // fork bomb
    ],
    reason: "Destructive command detected — can permanently delete data",
  },
  {
    band: "privileged",
    patterns: [
      /\bsudo\b/i,
      /\bchmod\b/i,
      /\bchown\b/i,
      /\bchgrp\b/i,
      /\bsetfacl\b/i,
    ],
    reason: "Privileged command — modifies system permissions or runs as root",
  },
  {
    band: "exfiltration-risk",
    patterns: [
      /\|\s*(curl|wget|nc|netcat|ssh|scp)\b/i,
      /\|\s*bash\b/i,
      /\|\s*sh\b/i,
      /\bcurl\s+.*\|\s*(bash|sh|python|perl)\b/i,
      /\bwget\s+.*\|\s*(bash|sh|python|perl)\b/i,
      /\bnc\s+.*\s+-l\b/i,
      /\bnetcat\b/i,
      /\bbase64\s+.*\|\s*(curl|wget)\b/i,
    ],
    reason: "Exfiltration risk — piping data to remote endpoints or executing remote scripts",
  },
  {
    band: "secret-risk",
    patterns: [
      /\bcat\s+.*\.env\b/i,
      /\bcat\s+~\/\.ssh\b/i,
      /\bcat\s+.*id_rsa\b/i,
      /\bcat\s+.*id_ed25519\b/i,
      /\bcat\s+.*\.pem\b/i,
      /\bcat\s+.*\.key\b/i,
      /\bless\s+.*\.env\b/i,
      /\bhead\s+.*\.env\b/i,
      /\btail\s+.*\.env\b/i,
      /\bgrep\s+.*\.env\b/i,
      /\bprintenv\b/i,
      /\benv\b(?!\s*$)/i, // env with args (not just env alone)
    ],
    reason: "Secret-risk command — may expose credentials or private keys",
  },
  {
    band: "network",
    patterns: [
      /\bcurl\b/i,
      /\bwget\b/i,
      /\bscp\b/i,
      /\brsync\b/i,
      /\bssh\b/i,
      /\bftp\b/i,
      /\bsftp\b/i,
      /\btelnet\b/i,
      /\bnc\b/i,
      /\bdig\b/i,
      /\bnslookup\b/i,
    ],
    reason: "Network command — makes outbound connections",
  },
  {
    band: "moderate",
    patterns: [
      /\bnpm\s+install\b/i,
      /\bnpm\s+i\b/i,
      /\byarn\s+install\b/i,
      /\byarn\s+add\b/i,
      /\bpip\s+install\b/i,
      /\bpip3\s+install\b/i,
      /\bcargo\s+build\b/i,
      /\bcargo\s+install\b/i,
      /\bgo\s+install\b/i,
      /\bmake\b/i,
      /\bbrew\s+install\b/i,
      /\bapt\s+install\b/i,
      /\bapt-get\s+install\b/i,
      /\bdocker\s+build\b/i,
      /\bdocker\s+run\b/i,
    ],
    reason: "Moderate risk — installs packages or builds code",
  },
  {
    band: "safe",
    patterns: [
      /^(\s*)(pwd|ls|cat|echo|grep|find|head|tail|wc|tree|du|df|file|which|whereis|whoami|date|uptime|uname|env)(\s|$)/i,
      /^(\s*)(git\s+(status|log|diff|branch|show|blame|remote|config\s+--list|rev-parse))(?!\s+--hard)(\s|$)/i,
      /^(\s*)(node\s+--version|npm\s+--version|npm\s+list|npx\s+--version|bun\s+--version|tsc\s+--version|python3?\s+--version|pip3?\s+--version)(\s|$)/i,
      /^(\s*)(mkdir\s+-p|rmdir|touch|cp|mv)(\s|$)/i,
    ],
    reason: "Safe command — read-only or low-risk filesystem operation",
  },
];

// ─── Default Blocked Patterns ─────────────────────────────────────────

export const DEFAULT_BLOCKED_PATTERNS: string[] = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "mkfs",
  "dd if=/dev/zero of=/dev/sda",
  ":(){ :|:& };:",
  "fork bomb",
];

// ─── Classification ────────────────────────────────────────────────────

/**
 * Classify a shell command string into a risk band.
 *
 * @param command - The raw shell command string
 * @returns Classification with risk band, reason, approval requirement, and hash
 */
export function classifyCommand(
  command: string,
  cwd?: string,
): CommandClassification {
  // Bind the approval key to (command + working directory) so an approval in
  // one project never auto-approves the same command in another (US-6.2).
  const hashInput = cwd ? `${command}\0${path.resolve(cwd)}` : command;
  const hash = crypto.createHash("sha256").update(hashInput).digest("hex").substring(0, 16);
  const trimmed = command.trim();

  // Normalize bash quoting constructs before pattern matching so obfuscation
  // like r""m, r''m, or $'rm' is detected as the actual command "rm".
  // This closes the quote-splitting bypass (CWE-78 - shell injection).
  const normalized = trimmed
    .replace(/\$'([^']*)'/g, "$1")   // $'rm' -> rm (ANSI-C quoting)
    .replace(/'([^']*)'/g, "$1")    // r'm' -> rm (single-quote splitting)
    .replace(/""/g, "");              // r""m -> rm (double-quote splitting)

  // Check for hard-blocked patterns first (against both raw and normalized)
  for (const blocked of DEFAULT_BLOCKED_PATTERNS) {
    if (
      trimmed.toLowerCase().includes(blocked.toLowerCase()) ||
      normalized.toLowerCase().includes(blocked.toLowerCase())
    ) {
      return {
        risk: "destructive",
        reason: `Hard-blocked pattern detected: '${blocked}'`,
        requiresApproval: true,
        hash,
      };
    }
  }

  // Check risk patterns in priority order (most dangerous first)
  const priorityOrder: RiskBand[] = [
    "destructive",
    "privileged",
    "exfiltration-risk",
    "secret-risk",
    "network",
    "moderate",
    "safe",
  ];

  for (const band of priorityOrder) {
    const patternGroup = RISK_PATTERNS.find((p) => p.band === band);
    if (!patternGroup) continue;

    for (const pattern of patternGroup.patterns) {
      if (pattern.test(trimmed) || pattern.test(normalized)) {
        const requiresApproval =
          band === "destructive" ||
          band === "privileged" ||
          band === "exfiltration-risk" ||
          band === "network" ||
          band === "secret-risk";
        return {
          risk: band,
          reason: patternGroup.reason,
          requiresApproval,
          hash,
        };
      }
    }
  }

  // Default: moderate risk for unknown commands
  return {
    risk: "moderate",
    reason: "Unknown command — defaulting to moderate risk",
    requiresApproval: false,
    hash,
  };
}

/**
 * Check if a command targets a path outside the workspace.
 * Returns true if the command appears to operate on files outside the workspace root.
 */
export function targetsOutsideWorkspace(command: string, workspaceRoot: string): boolean {
  // Check for absolute paths that are outside workspace
  const absPathPattern = /(?:^|\s)(\/(?:[^/\s]+\/)*[^/\s]+)/g;
  const matches = command.match(absPathPattern);
  if (!matches) return false;

  for (const match of matches) {
    const cleaned = match.trim();
    if (!cleaned.startsWith("/")) continue;
    // Check if it's a system path, not inside workspace
    if (!cleaned.startsWith(workspaceRoot) && cleaned !== workspaceRoot) {
      // Allow common system paths that are read-only
      const systemPaths = ["/usr", "/bin", "/lib", "/etc", "/opt", "/tmp", "/var"];
      if (systemPaths.some((p) => cleaned.startsWith(p))) {
        // System paths are only concerning for write operations
        continue;
      }
      if (cleaned.startsWith("/Users/") || cleaned.startsWith("/home/")) {
        // Home directory paths outside workspace
        return true;
      }
    }
  }

  return false;
}
