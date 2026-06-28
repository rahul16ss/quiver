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
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * Get the CSP header value for the session.
 */
export function getCspHeader(): string {
  return CSP_POLICY;
}

// ─── Navigation Blocking ─────────────────────────────────────────────

/**
 * Check if a URL is a trusted origin that the main frame or child frames
 * are allowed to navigate to.
 */
export function isTrustedOrigin(url: string): boolean {
  // Only allow local file:// protocol and about:blank
  if (url.startsWith("file://")) return true;
  if (url === "about:blank") return true;
  if (url === "about:blank#blocked") return true;

  // Block everything else (http, https, data, blob, etc. in main frame)
  return false;
}

/**
 * Check if a URL should be blocked from loading in any context.
 */
export function shouldBlockUrl(url: string): boolean {
  // Block known dangerous protocols
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

/**
 * Get the security headers to set on the session.
 */
export function getSecurityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CSP_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "no-referrer",
  };
}

/**
 * Sanitize a file path to prevent path traversal in the renderer.
 * Removes .. and ensures the path stays within the allowed directory.
 */
export function sanitizePath(inputPath: string, allowedBase: string): string | null {
  const path = require("path");
  const resolved = path.resolve(allowedBase, inputPath);
  const relative = path.relative(allowedBase, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null; // Path traversal attempt
  }

  return resolved;
}