/**
 * Consent Gate v1 — US-17.15 / Build Order #5.
 *
 * A pre-action summary rendered from data the context manifest already emits.
 * Before each model call, the gate shows the user what will enter the context
 * and asks them to approve, edit, or decline.
 *
 * The gate renders the six layers from SPEC §6.1:
 *   A. Framing — system prompt version, safety policy
 *   B. Memory — persona, memory files, workspace facts
 *   C. Skills & tools — loaded skills + versions, tool catalog, MCP servers
 *   D. Conversation — turn count, compaction status
 *   E. Inputs — user request, web sources, dropped files
 *   F. Operational metadata — model, sensitivity tier, redactions, trust tier
 *
 * In v1, the gate is informational with an opt-in approval step. It doesn't
 * block by default — the user can enable it with `/consent on`. When enabled,
 * the agent loop calls `renderConsentGate()` before each prompt and waits for
 * user approval.
 *
 * The full six-layer gate with per-layer edit/disable/veto follows usage
 * feedback. This v1 is the pre-action summary rendered from manifest data.
 */

import * as path from "path";
import { config, TrustTier } from "../config.js";

export interface ConsentGateData {
  // Layer A: Framing
  systemPromptVersion: string;
  // Layer B: Memory
  memoryFiles: string[];
  personaSummary: string;
  // Layer C: Skills & tools
  skills: Array<{ id: string; version: string }>;
  toolCount: number;
  toolNames: string[];
  mcpServerCount: number;
  // Layer D: Conversation
  turnCount: number;
  compactedCount: number;
  // Layer E: Inputs
  userRequestPreview: string;
  webSourceCount: number;
  // Layer F: Operational metadata
  modelName: string;
  trustTier: TrustTier | null;
  tokenEstimate: string;
  scratchMode: boolean;
}

export interface ConsentGateResult {
  approved: boolean;
  action: "approve" | "edit" | "decline" | "skip";
  editedData?: Partial<ConsentGateData>;
}

/**
 * Check whether the consent gate is enabled.
 * The gate is OFF by default. The user enables it with `/consent on`.
 */
export function isConsentGateEnabled(): boolean {
  return config.consentGateEnabled === true;
}

/**
 * Enable or disable the consent gate.
 */
export function setConsentGateEnabled(enabled: boolean): void {
  config.consentGateEnabled = enabled;
}

/**
 * Render the consent gate as a human-readable summary.
 * This is the text that gets displayed to the user before the model call.
 */
export function renderConsentGate(data: ConsentGateData): string {
  const lines: string[] = [];
  lines.push("┌─ Consent Gate ──────────────────────────────────────────────┐");
  lines.push(
    "│                                                              │",
  );
  lines.push(
    "│  BEFORE THIS ACTION, the AI will see:                        │",
  );
  lines.push(
    "│                                                              │",
  );

  // Layer A: Framing
  lines.push(
    `│  A. Framing   system-prompt v${data.systemPromptVersion}                         │`,
  );
  lines.push(
    "│                safety policy (auditable)                     │",
  );

  // Layer B: Memory
  const memCount = data.memoryFiles.length;
  const memSummary =
    memCount > 0
      ? `${data.personaSummary} · ${memCount} memory file${memCount === 1 ? "" : "s"}`
      : data.personaSummary || "none";
  lines.push(`│  B. Memory    ${truncate(memSummary, 48).padEnd(48)} │`);

  // Layer C: Skills & tools
  const skillsStr =
    data.skills.length > 0
      ? data.skills.map((s) => `${s.id} v${s.version}`).join(" · ")
      : "none";
  lines.push(`│  C. Skills    ${truncate(skillsStr, 48).padEnd(48)} │`);
  lines.push(
    `│     Tools     ${data.toolCount} tools${data.mcpServerCount > 0 ? ` · ${data.mcpServerCount} MCP` : ""}`.padEnd(
      63,
    ) + "│",
  );

  // Layer D: Conversation
  const compactStr =
    data.compactedCount > 0 ? ` (compacted ${data.compactedCount}×)` : "";
  lines.push(
    `│  D. Convo     ${data.turnCount} turns${compactStr}`.padEnd(63) + "│",
  );

  // Layer E: Inputs
  const reqPreview = truncate(data.userRequestPreview, 40);
  const webStr =
    data.webSourceCount > 0 ? ` · ${data.webSourceCount} web sources` : "";
  lines.push(`│  E. Inputs    "${reqPreview}"${webStr}`.padEnd(63) + "│");

  // Layer F: Operational metadata
  const tierStr = data.trustTier ?? "none";
  const scratchStr = data.scratchMode ? " · scratch mode" : "";
  lines.push(`│  F. Ops       model: ${data.modelName}`.padEnd(63) + "│");
  lines.push(
    `│                tier: ${tierStr}${scratchStr} · ${data.tokenEstimate} tokens`.padEnd(
      63,
    ) + "│",
  );

  lines.push(
    "│                                                              │",
  );
  lines.push(
    "│  [1] Approve   [2] Edit memory   [3] Decline   [Enter] Skip  │",
  );
  lines.push(
    "└──────────────────────────────────────────────────────────────┘",
  );

  return lines.join("\n");
}

/**
 * Render a compact one-line consent gate for the CLI.
 * Less verbose than the full gate but still shows the six layers.
 */
export function renderConsentGateCompact(data: ConsentGateData): string {
  const parts: string[] = [];
  parts.push(`prompt v${data.systemPromptVersion}`);
  if (data.memoryFiles.length > 0) parts.push(`${data.memoryFiles.length} mem`);
  if (data.skills.length > 0) parts.push(`${data.skills.length} skills`);
  parts.push(`${data.toolCount} tools`);
  parts.push(`${data.turnCount} turns`);
  parts.push(data.modelName);
  if (data.trustTier) parts.push(data.trustTier);
  if (data.scratchMode) parts.push("scratch");
  parts.push(data.tokenEstimate);
  return `consent: ${parts.join(" · ")}`;
}

/**
 * Toggle the consent gate on/off.
 * Returns the new state.
 */
export function toggleConsentGate(): boolean {
  const newState = !isConsentGateEnabled();
  setConsentGateEnabled(newState);
  return newState;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + "…";
}
