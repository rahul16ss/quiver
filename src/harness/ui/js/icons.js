// ─── document kind icons + activity status icons ───────────────────────
const DOC_KINDS = {
  docx: {
    iconClass: "word",
    label: "Word document",
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h5"/></svg>',
  },
  xlsx: {
    iconClass: "excel",
    label: "Excel spreadsheet",
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/><path d="M14 13l4 5M18 13l-4 5"/></svg>',
  },
  pptx: {
    iconClass: "ppt",
    label: "PowerPoint presentation",
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8M12 18v2"/><path d="M8 8h4.5a2.5 2.5 0 0 1 0 5H8z"/></svg>',
  },
};
function docKindFor(filePath) {
  const ext = String(filePath).split(".").pop().toLowerCase();
  return DOC_KINDS[ext] || DOC_KINDS.docx;
}
const OFFICE_MUTATING_ACTIONS = new Set([
  "create",
  "add",
  "set",
  "remove",
  "move",
  "swap",
  "batch",
  "save",
  "merge",
  "import",
]);

const STATUS_ICONS = {
  ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M4.7 9.2 1.8 6.3l.9-.9 2 2 4.2-4.2.9.9z"/></svg>',
  warn: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="1.2" fill="currentColor"/><circle cx="3" cy="6" r="1.2" fill="currentColor"/><circle cx="9" cy="6" r="1.2" fill="currentColor"/></svg>',
  err: '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M6 1.2 10.8 10H1.2L6 1.2zm0 2.6-.9 3.4h1.8L6 3.8zM5.3 8.2h1.4V9.6H5.3z"/></svg>',
  verify:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M4.7 9.2 1.8 6.3l.9-.9 2 2 4.2-4.2.9.9z"/></svg>',
  flagged:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M2.2 1.5h.9v9H2.2zm1.5 0H9.5L8.2 4.2 9.5 7H3.7z"/></svg>',
  pending:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="1.4" fill="currentColor"/></svg>',
  needs:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path fill="currentColor" d="M5.2 8.6h1.6V10H5.2zM6 2a2.6 2.6 0 0 1 2.6 2.6c0 1.2-.7 1.8-1.5 2.4-.5.4-.7.6-.7 1.2H5.2c0-1 .5-1.5 1.2-2 .7-.5 1.2-.9 1.2-1.6A1.4 1.4 0 0 0 6 3.4 1.4 1.4 0 0 0 4.6 4.8H3.2A2.8 2.8 0 0 1 6 2z"/></svg>',
};

export { DOC_KINDS, docKindFor, OFFICE_MUTATING_ACTIONS, STATUS_ICONS };
