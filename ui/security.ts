/**
 * Electron Security Hardening — US-8.1
 *
 * Enforces strict Content Security Policy (CSP), blocks navigation to
 * untrusted origins, and provides security validation utilities.
 */

// ─── CSP Policy ──────────────────────────────────────────────────────

/**
 * The strict Content Security Policy for the Electron renderer.
 * Blocks external scripts and unsanctioned network endpoints.
 */
// Browser-UI security helpers are owned by the harness (ADR-009) and re-exported
// here so legacy imports keep working during the experience-plane migration.
export {
  CSP_POLICY,
  getCspHeader,
  isTrustedOrigin,
  shouldBlockUrl,
  getSecurityHeaders,
  sanitizePath,
} from "../src/harness/daemon-security.js";

// Re-declare as local consts for the Electron-specific checks below.
import { CSP_POLICY as _CSP } from "../src/harness/daemon-security.js";
const CSP_POLICY = _CSP;
function getCspHeader(): string { return CSP_POLICY; }
function isTrustedOrigin(url: string): boolean {
  if (url.startsWith("file://")) return true;
  if (url === "about:blank" || url === "about:blank#blocked") return true;
  return false;
}
function shouldBlockUrl(url: string): boolean {
  const blockedProtocols = ["javascript:", "vbscript:", "data:text/html"];
  return blockedProtocols.some((p) => url.toLowerCase().startsWith(p));
}

// ─── Electron Hardening Checklist ────────────────────────────────────

/**
 * The Electron hardening rules that must be enforced.
 * This serves as a documentation and validation checklist.
 */
export const ELECTRON_HARDENING_RULES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  remoteModule: false,
  csp: CSP_POLICY,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
} as const;

/**
 * Validate that a BrowserWindow configuration meets security requirements.
 * Returns a list of violations (empty if compliant).
 */
export function validateWindowConfig(webPreferences: any): string[] {
  const violations: string[] = [];

  if (webPreferences.contextIsolation !== true) {
    violations.push("contextIsolation must be true");
  }
  if (webPreferences.nodeIntegration !== false) {
    violations.push("nodeIntegration must be false");
  }
  if (webPreferences.sandbox !== true) {
    violations.push("sandbox must be true");
  }
  if (webPreferences.enableRemoteModule !== false && webPreferences.enableRemoteModule !== undefined) {
    violations.push("enableRemoteModule must be false or undefined");
  }
  if (webPreferences.webSecurity === false) {
    violations.push("webSecurity must not be disabled");
  }
  if (webPreferences.allowRunningInsecureContent === true) {
    violations.push("allowRunningInsecureContent must be false");
  }

  return violations;
}

// getSecurityHeaders + sanitizePath are re-exported from the harness above.