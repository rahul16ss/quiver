/**
 * Targeted checker filter — US-15.3.
 *
 * Maps file paths and tool names to the relevant acceptance check IDs, so the
 * checker can run a targeted subset instead of the full 143-check suite on
 * every high-risk operation.
 *
 * The mapping is based on which source files each acceptance check inspects.
 * When a write_file/replace_content/apply_patch targets a specific file, we
 * resolve the checks that actually read or import that file. When a run_command
 * is classified as high-risk, we run the command-policy + security checks.
 *
 * Always-on checks (global gates):
 *   - TSC-CLEAN (DoD) — TypeScript compilation must always pass
 *   - MAKER-CHECKER-MODULE / SEPARATION / SCRATCHPAD / SPEC-AWARE / AUDIT-OVERRIDE
 *     — the checker must always verify its own integrity
 */
export interface TargetedChecks {
  /** Check IDs to run (e.g., ["TSC-CLEAN", "CMD-DESTRUCTIVE-APPROVAL"]) */
  checkIds: string[];
  /** Whether this is a full run (no filtering) */
  full: boolean;
  /** Human-readable reason for the selection */
  reason: string;
}

// ─── File → check ID mapping ───────────────────────────────────────────
// Each entry maps a source file (relative to project root) to the acceptance
// check IDs that directly inspect or import that file.
const FILE_TO_CHECKS: Record<string, string[]> = {
  // Cloud sync
  "src/cloud_sync.ts": [
    "SYNC-DEFAULT-OFF",
    "SYNC-DETECT-NOT-ACTIVE",
    "SYNC-STATUS-NO-SIDE-EFFECTS",
    "SYNC-NOOP-WHEN-DISABLED",
    "SYNC-ISACTIVE-OPT-IN",
    "SYNC-EXCLUDE-RAW-LOGS",
    "SYNC-EXCLUDE-SCREENSHOTS",
    "SYNC-EXCLUDE-TOOL-BINARIES",
    "SYNC-EXCLUDE-SECRETS",
    "SYNC-KEEP-MEMORY",
    "SYNC-ENCRYPTED-AT-REST",
  ],
  // Command policy
  "src/security/command_policy.ts": [
    "CMD-SECRET-RISK-APPROVAL",
    "CMD-DESTRUCTIVE-APPROVAL",
    "CMD-PRIVILEGED-APPROVAL",
    "CMD-NETWORK-APPROVAL",
    "CMD-EXFIL-APPROVAL",
    "CMD-SAFE-NO-APPROVAL",
    "CMD-AST-VARIABLE-RESOLUTION",
    "CMD-APPROVAL-BOUND-TO-CWD",
    "CMD-TARGET-OUTSIDE-WORKSPACE",
    "CMD-MODERATE-BAND",
    "WIRE-COMMAND-CLASSIFIER",
  ],
  // File access (compare-and-swap)
  "src/session/file_access.ts": [
    "FA-RECORD-FIELDS",
    "FA-UNREAD-EXISTING-BLOCKED",
    "FA-CREATION-PASSES",
    "FA-HASH-MISMATCH-BLOCKS",
    "FA-MTIME-MISMATCH-BLOCKS",
    "WIRE-FILE-ACCESS-CAS",
  ],
  // Secrets
  "src/security/secrets.ts": ["SECRET-DETECT-REDACT", "SECRET-REMOTE-WARN"],
  // Path policy
  "src/security/path_policy.ts": [
    "PATH-SYMLINK-ESCAPE",
    "PATH-INSIDE-WORKSPACE",
    "PATH-BLOCKED-GLOBS",
    "WIRE-PATH-SANDBOX-TOOLS",
  ],
  // GUI security
  "ui/security.ts": [
    "GUI-SANDBOX-WIRED",
    "GUI-CSP-ENFORCED",
    "GUI-HARDENING-RULES",
    "GUI-NAV-BLOCKING",
  ],
  "ui/ipc_contract.ts": ["GUI-IPC-CONTRACT"],
  // Scratch area (Draft & research tier)
  "src/security/scratch_area.ts": [
    "SCRATCH-AREA-MODULE-EXISTS",
    "SCRATCH-AREA-REDIRECT",
    "SCRATCH-AREA-PROMOTE",
    "SCRATCH-AREA-LIST",
  ],
  // Consent gate
  "src/security/consent_gate.ts": [
    "CONSENT-GATE-MODULE-EXISTS",
    "CONSENT-GATE-RENDER",
    "CONSENT-GATE-TOGGLE",
  ],
  // Sensitivity routing
  "src/security/sensitivity.ts": [
    "SENSITIVITY-MODULE-EXISTS",
    "SENSITIVITY-CLASSIFY",
    "SENSITIVITY-REDACT",
    "SENSITIVITY-ROUTE",
  ],
  // Connector framework
  "src/connectors/framework.ts": [
    "CONNECTOR-FRAMEWORK-EXISTS",
    "CONNECTOR-FRAMEWORK-INTERFACE",
    "CONNECTOR-FRAMEWORK-CACHE",
    "CONNECTOR-FRAMEWORK-REGISTRY",
  ],
  "src/tools/data_query.ts": [
    "CONNECTOR-TOOL-EXISTS",
    "CONNECTOR-TOOL-ACTIONS",
    "CONNECTOR-TOOL-DISPLAY-NAME",
  ],
  // Evidence model (live lineage)
  "src/evidence/model.ts": [
    "EVIDENCE-MODEL-EXISTS",
    "EVIDENCE-MODEL-TYPES",
  ],
  "src/evidence/tracker.ts": [
    "EVIDENCE-TRACKER-EXISTS",
    "EVIDENCE-TRACKER-VALIDATE",
    "EVIDENCE-TRACKER-FINALIZE",
  ],
  "src/tools/evidence.ts": [
    "EVIDENCE-TOOL-EXISTS",
    "EVIDENCE-TOOL-ACTIONS",
  ],
  // Config
  "src/config.ts": ["CONFIG-MODEL-DEFAULTS-IN-SOURCE", "CONFIG-SINGLE-API-KEY"],
  "src/config/schema.ts": [
    "CONFIG-SCHEMA-VALIDATE-MIGRATE",
    "SECRET-SCHEMA-USES-REFS",
    "SYNC-DEFAULT-OFF",
  ],
  // Onboarding
  "src/onboarding.ts": [
    "ONBOARDING-HANDSHAKE",
    "ONBOARDING-REMOTE-DISCLOSURE",
    "FIRST-RUN-CORE-JSON",
  ],
  // GUI main
  "ui/main.ts": [
    "GUI-IMPORTS-RESOLVE",
    "GUI-WINDOW-STATE-PERSISTED",
    "GUI-DIFF-APPROVAL",
    "GUI-SETTINGS-IPC-WIRED",
    "GUI-SETTINGS-SYNC-IPC",
    "GUI-SETTINGS-MEMORY-IPC",
    "SESSION-ARCHIVE-PERMANENT-FLAG",
  ],
  // GUI renderer
  "ui/renderer.ts": ["GUI-OUTFIT-TYPOGRAPHY", "GUI-DIFF-APPROVAL"],
  // CLI
  "src/cli.ts": [
    "CRASH-NO-AUTO-DISCARD",
    "SESSION-LIST-METADATA",
    "CRASH-RECOVERY-PROMPTS",
    "LOGS-SLASH-COMMAND",
    "ROLLBACK-SLASH-COMMAND",
    "SUBCOMMAND-BYPASSES-ONBOARDING",
    "MEMORY-REVIEW-CLI",
    "CLEANUP-CLI-WIRED",
  ],
  "src/cli_ui.ts": [
    "STATUS-LINE-NUMBER-FORMAT",
    "MULTILINE-NO-ESCAPE-NON-TTY",
    "CLEANUP-CLI-WIRED",
  ],
  // Diff
  "src/diff.ts": ["DIFF-UNIFIED-HEADERS", "DIFF-RISKY-FILES"],
  // Atomic write
  "src/fs/atomic_write.ts": [
    "ATOMIC-WRITE-ROLLBACK",
    "WIRE-ATOMIC-WRITE-TOOLS",
  ],
  // Prompt assembler
  "src/prompt/assembler.ts": [
    "PROMPT-ASSEMBLY-SECTIONS",
    "WIRE-PROMPT-ASSEMBLER",
  ],
  // Context budget
  "src/context/budget.ts": ["BUDGET-85-THRESHOLD", "WIRE-TOKEN-BUDGET"],
  // Tool sandbox
  "src/tools/sandbox.ts": ["TOOL-SANDBOX-MANIFEST"],
  // (subagent pool removed — dead code)
  // Diagnostics
  "src/diagnostics.ts": ["DIAGNOSTICS-FAILURE-LOOP", "WIRE-DIAGNOSTICS"],
  // Logger / audit
  "src/logger.ts": ["AUDIT-CHAIN-TAMPER-EVIDENT", "RETRY-BACKOFF-MATH"],
  // Memory
  "src/memory/citation_parser.ts": ["CITATION-PARSER", "WIRE-CITATION-DECAY"],
  "src/memory/decay.ts": ["CITATION-DECAY-FORMULA"],
  "src/memory/privacy.ts": ["MEMORY-PRIVACY-REMOTE", "WIRE-MEMORY-PRIVACY"],
  "src/memory/schema.ts": [
    "EXTRACTION-WRITES-PENDING",
    "PENDING-FACTS-NOT-IN-CONTEXT",
    "MEMORY-REVIEW-WIRED",
  ],
  // Vision
  "src/vision_router.ts": [
    "VISION-EXIF-REDACTED",
    "VISION-DOWNSCALE",
    "VISION-REMOTE-CONSENT",
    "VISION-CONFIG-WIRED",
    "VISION-SIZE-LIMIT",
  ],
  "src/image_input.ts": [
    "VISION-EXIF-REDACTED",
    "VISION-DOWNSCALE",
    "VISION-SIZE-LIMIT",
  ],
  // Retry
  "src/tool_retry.ts": ["RETRY-IDEMPOTENT-ONLY", "RETRY-BACKOFF-MATH"],
  // Security prompts
  "src/prompts/security.ts": [
    "UNTRUSTED-WRAP-WIRED",
    "UNTRUSTED-PREAMBLE-WIRED",
    "UNTRUSTED-WRAP-HELPERS",
    "UNTRUSTED-WRAP-BEHAVIORAL",
  ],
  // Adapters
  "src/adapters/types.ts": [
    "ADAPTER-PROMPT-ORDER",
    "ADAPTER-TOOL-FORMAT",
    "ADAPTER-ERROR-RECOVERY",
    "ADAPTER-CITATION-STYLE",
  ],
  // Context manager
  "src/context_manager.ts": [
    "COMPACTION-ARCHIVES-FULL-LOG",
    "COMPACTION-RETAINS-RECENT-TOOL-MSG",
  ],
  // Session manager
  "src/session/manager.ts": [
    "SESSION-LIST-METADATA",
    "SESSION-SCHEMA-FIELDS",
    "SESSION-ARCHIVE-SOFT-DELETE",
  ],
  // Registry
  "src/registry.ts": ["TOOL-SCAN-NO-INFRA-WARNINGS"],
  // (tool selector removed — dead code)
  // Lifecycle
  "src/lifecycle.ts": ["WIRE-LIFECYCLE-HOOKS", "MAKER-CHECKER-MODULE"],
  // Agent
  "src/agent.ts": [
    "WIRE-PROVIDER-ADAPTER",
    "WIRE-PROMPT-ASSEMBLER",
    "WIRE-TOKEN-BUDGET",
    "WIRE-PATH-SANDBOX-TOOLS",
    "WIRE-COMMAND-CLASSIFIER",
    "WIRE-FILE-ACCESS-CAS",
    "WIRE-ATOMIC-WRITE-TOOLS",
    "WIRE-CHECKPOINT-CRASH",
    "WIRE-DIAGNOSTICS",
    "WIRE-MEMORY-PRIVACY",
    "WIRE-CITATION-DECAY",
    "WIRE-LIFECYCLE-HOOKS",
    "WIRE-TOOL-ARGS-VALIDATED",
    "STREAMING-NO-SPINNER-CLOBBER",
    "STREAM-ABORT-CONTROLLER",
    "STREAM-ABORT-METHOD",
    "STREAM-ABORT-SIGINT-WIRED",
    "HIDDEN-COT-NOT-PERSISTED",
  ],
  // Checker itself
  "src/subagents/checker.ts": [
    "MAKER-CHECKER-MODULE",
    "MAKER-CHECKER-SEPARATION",
    "MAKER-CHECKER-SCRATCHPAD",
    "MAKER-CHECKER-SPEC-AWARE",
    "MAKER-CHECKER-AUDIT-OVERRIDE",
  ],
  "src/subagents/scratchpad_helpers.ts": ["MAKER-CHECKER-SCRATCHPAD"],
  // (adversarial removed — dead code)
  // GUI settings
  "ui/settings.ts": ["GUI-SETTINGS-SECTIONS"],
  // Memory review queue
  "src/memory/review_queue.ts": ["MEMORY-REVIEW-QUEUE-MODULE"],
  // (cleanup removed — dead code)
  // Project
  "src/project.ts": ["PROJECT-JSON-SCHEMA"],
  // Slash commands
  "src/slash_commands.ts": [],
  // Docs
  "docs/security/threat-model.md": ["THREAT-MODEL-DOC"],
  "docs/security/soc2-mapping.md": ["SOC2-MAPPING-DOC"],
  "docs/index.html": ["LANDING-PAGE-HERO"],
  // Homebrew
  "Formula/quiver.rb": ["HOMEBREW-REAL-SHA256"],
};

// ─── Tool name → check ID mapping ──────────────────────────────────────
// When the high-risk operation is a run_command, we run the command-policy
// checks. For file-writing tools, the file path determines the checks.
const TOOL_TO_CHECKS: Record<string, string[]> = {
  run_command: [
    "CMD-SECRET-RISK-APPROVAL",
    "CMD-DESTRUCTIVE-APPROVAL",
    "CMD-PRIVILEGED-APPROVAL",
    "CMD-NETWORK-APPROVAL",
    "CMD-EXFIL-APPROVAL",
    "CMD-SAFE-NO-APPROVAL",
    "CMD-AST-VARIABLE-RESOLUTION",
    "CMD-APPROVAL-BOUND-TO-CWD",
    "CMD-TARGET-OUTSIDE-WORKSPACE",
    "CMD-MODERATE-BAND",
    "WIRE-COMMAND-CLASSIFIER",
  ],
};

// ─── Always-on checks ──────────────────────────────────────────────────
// These checks are global gates — they must always pass regardless of which
// file was modified. TSC-CLEAN ensures compilation. The maker-checker checks
// ensure the checker's own integrity.
const ALWAYS_ON_CHECKS = [
  "TSC-CLEAN",
  "MAKER-CHECKER-MODULE",
  "MAKER-CHECKER-SEPARATION",
  "MAKER-CHECKER-SCRATCHPAD",
  "MAKER-CHECKER-SPEC-AWARE",
  "MAKER-CHECKER-AUDIT-OVERRIDE",
];

/**
 * Resolve which acceptance checks to run for a given high-risk operation.
 *
 * @param toolName - The tool being executed (e.g., "write_file", "run_command")
 * @param toolArgs - The tool's arguments (may contain filePath, command, etc.)
 * @returns TargetedChecks with the check IDs to run
 */
export function resolveTargetedChecks(
  toolName: string,
  toolArgs?: any,
): TargetedChecks {
  // For run_command, use the tool-based mapping
  if (toolName === "run_command") {
    const checks = [
      ...new Set([
        ...(TOOL_TO_CHECKS["run_command"] || []),
        ...ALWAYS_ON_CHECKS,
      ]),
    ];
    return {
      checkIds: checks,
      full: false,
      reason: `run_command → command-policy checks + always-on gates (${checks.length} checks)`,
    };
  }

  // For file-writing tools, extract the file path
  let filePath = "";
  if (toolName === "write_file" || toolName === "replace_content") {
    filePath = toolArgs?.filePath || toolArgs?.path || "";
  } else if (toolName === "apply_patch") {
    // apply_patch has a patch string; extract the first file path from --- a/path
    const patch: string = toolArgs?.patch || "";
    const m = patch.match(/^\+\+\+\s+b\/(.+)$/m);
    filePath = m ? m[1] : "";
  } else if (toolName === "create_tool") {
    // create_tool writes to ~/.quiver/projects/{id}/tools/ — check tool sandbox
    const checks = [
      ...new Set([
        "TOOL-SANDBOX-MANIFEST",
        "CREATE-TOOL-DISABLED-BY-DEFAULT",
        "CREATE-TOOL-PROJECT-LOCAL",
        ...ALWAYS_ON_CHECKS,
      ]),
    ];
    return {
      checkIds: checks,
      full: false,
      reason: `create_tool → tool sandbox checks + always-on gates (${checks.length} checks)`,
    };
  }

  if (!filePath) {
    // Can't determine the file — run all checks (safe fallback)
    return {
      checkIds: [],
      full: true,
      reason: "unable to determine target file — running full suite",
    };
  }

  // Normalize the path (remove leading ./, normalize separators)
  const normalized = filePath.replace(/^\.\//, "").replace(/\\/g, "/");

  // Look up the file in our mapping
  const fileChecks = FILE_TO_CHECKS[normalized] || [];

  if (fileChecks.length === 0) {
    // Unknown file — run all checks (safe fallback)
    return {
      checkIds: [],
      full: true,
      reason: `unknown file ${normalized} — running full suite`,
    };
  }

  // Combine file-specific checks with always-on checks, deduplicated
  const checks = [...new Set([...fileChecks, ...ALWAYS_ON_CHECKS])];

  return {
    checkIds: checks,
    full: false,
    reason: `${normalized} → ${fileChecks.length} file checks + ${ALWAYS_ON_CHECKS.length} always-on gates (${checks.length} total)`,
  };
}

/**
 * Serialize check IDs to a comma-separated string for env var passing.
 */
export function serializeCheckFilter(checkIds: string[]): string {
  return checkIds.join(",");
}

/**
 * Deserialize check IDs from a comma-separated string.
 */
export function deserializeCheckFilter(filter: string): string[] {
  return filter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
