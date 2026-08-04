// Strict Content-Security-Policy enforced on the renderer (US-8.1).
// Mirrors ui/security.ts CSP_POLICY; kept here so the main process has no
// unresolved relative import (the renderer CSP contract lives in security.ts).
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
