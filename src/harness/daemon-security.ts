/**
 * Daemon/browser-UI security surface — Phase 8 (ADR-009).
 *
 * The loopback browser UI's security helpers, owned by the harness (not the
 * Electron app). The legacy ui/security.ts re-exports these so existing
 * imports keep working during the experience-plane migration.
 */

/** Strict Content Security Policy for the browser UI. */
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

export function getCspHeader(): string {
  return CSP_POLICY;
}

/**
 * A trusted origin for the browser UI: only the loopback daemon origin and
 * about:blank. The daemon itself enforces loopback-only binding + strict Host
 * validation (see daemon.ts); this helper is for UI-side navigation guards.
 */
export function isTrustedOrigin(url: string): boolean {
  if (url.startsWith("file://")) return true;
  if (url === "about:blank" || url === "about:blank#blocked") return true;
  // The loopback daemon origin is trusted.
  if (/^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url) || /^http:\/\/localhost(:\d+)?\//.test(url)) return true;
  return false;
}

/** Block known dangerous protocols from loading in any context. */
export function shouldBlockUrl(url: string): boolean {
  const blockedProtocols = ["javascript:", "vbscript:", "data:text/html"];
  return blockedProtocols.some((p) => url.toLowerCase().startsWith(p));
}

/** Security headers the daemon sets on every response (also enforced in daemon.ts). */
export function getSecurityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CSP_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "no-referrer",
  };
}

/** Sanitize a file path to prevent path traversal in the UI. */
export function sanitizePath(inputPath: string, allowedBase: string): string | null {
  const path = require("path");
  const resolved = path.resolve(allowedBase, inputPath);
  const relative = path.relative(allowedBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}