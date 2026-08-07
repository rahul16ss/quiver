// ─── tiny helpers ─────────────────────────────────────────────────────
// ─── tiny helpers ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const nowTime = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export { $, escapeHtml, nowTime };
