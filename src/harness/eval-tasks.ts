/**
 * Starter routing-eval task suite (v1) — synthetic, credential-free
 * capital-markets tasks with deterministic rubrics.
 *
 * These are intentionally small and synthetic (no client data, no MNPI).
 * Engagements extend the suite with their own packs; the suite hash records
 * which definition produced an evidence snapshot.
 */

import type { EvalTask } from "./routing-eval.js";

const FILING_EXCERPT = `Project Alder ("the Company") reported fiscal Q2 revenue of $48.2 million,
up 17.8% year-over-year, with EBITDA of $10.8 million (22.4% margin). The top
ten customers accounted for approximately 41% of revenue. Net leverage was
3.4x at quarter end.`;

export const STARTER_EVAL_TASKS: EvalTask[] = [
  // ── Extraction (text) ──────────────────────────────────────────────
  {
    id: "extract-revenue-verbatim",
    family: "extraction",
    role: "maker",
    modality: "text-only",
    prompt: `From this filing excerpt, state the company's fiscal Q2 revenue exactly as reported, with the figure. Excerpt:\n\n${FILING_EXCERPT}`,
    rubric: [
      {
        id: "contains-exact-figure",
        description: "Output contains the exact reported figure $48.2 million",
        pass: (o) => /\$?48\.2\s*m(illion)?/i.test(o),
      },
      {
        id: "no-invented-figure",
        description: "Output does not invent a different revenue figure",
        pass: (o) =>
          !/\$?(4[0-9]\.[0-9]|5[0-9]\.[0-9])\s*m(illion)?/i.test(
            o.replace(/48\.2\s*m(illion)?/i, ""),
          ),
      },
    ],
  },
  {
    id: "extract-margin-and-leverage",
    family: "extraction",
    role: "maker",
    modality: "text-only",
    prompt: `From the excerpt, report EBITDA margin and net leverage. Excerpt:\n\n${FILING_EXCERPT}`,
    rubric: [
      { id: "margin", description: "22.4% margin present", pass: (o) => /22\.4\s*%/.test(o) },
      { id: "leverage", description: "3.4x leverage present", pass: (o) => /3\.4\s*x/i.test(o) },
    ],
  },
  // ── Review (checker role): must catch the unsourced figure ────────
  {
    id: "review-flags-unsourced-figure",
    family: "review",
    role: "checker",
    modality: "text-only",
    prompt:
      `You are an independent checker. A draft claims: "Revenue grew 31% to $52.0 million." ` +
      `The only approved source says: "${FILING_EXCERPT}" ` +
      `Reply FLAG if the draft conflicts with or is unsupported by the source; reply OK only if it matches.`,
    rubric: [
      {
        id: "flags",
        description: "Checker flags the unsupported figure",
        pass: (o) => /FLAG/i.test(o),
      },
      {
        id: "not-ok-only",
        description: "Does not rubber-stamp",
        pass: (o) => !/^\s*OK\s*$/i.test(o),
      },
    ],
  },
  {
    id: "review-accepts-sourced-figure",
    family: "review",
    role: "checker",
    modality: "text-only",
    prompt:
      `You are an independent checker. A draft claims: "Q2 revenue was $48.2 million (up 17.8% YoY)." ` +
      `The approved source says: "${FILING_EXCERPT}" ` +
      `Reply OK if the draft matches the source; reply FLAG otherwise.`,
    rubric: [
      {
        id: "accepts",
        description: "Checker accepts the sourced figure",
        pass: (o) => /\bOK\b/.test(o),
      },
      {
        id: "no-false-flag",
        description: "Does not flag a correct figure",
        pass: (o) => !/FLAG/i.test(o),
      },
    ],
  },
  // ── Drafting: disciplined memo language ────────────────────────────
  {
    id: "draft-memo-paragraph-grounded",
    family: "drafting",
    role: "maker",
    modality: "text-only",
    prompt:
      `Draft a two-sentence investment-committee memo paragraph using ONLY these facts: ` +
      `"${FILING_EXCERPT}" Do not add any fact not in the excerpt.`,
    rubric: [
      { id: "uses-revenue", description: "Mentions $48.2m revenue", pass: (o) => /48\.2/.test(o) },
      {
        id: "no-unsourced-superlatives",
        description: "No invented claims (best-in-class, market-leading, etc.)",
        pass: (o) => !/best-in-class|market[- ]leading|unmatched|world-class/i.test(o),
      },
    ],
  },
  // ── Reconciliation: conflicting sources ────────────────────────────
  {
    id: "reconcile-conflict-honest",
    family: "reconciliation",
    role: "maker",
    modality: "text-only",
    prompt:
      `Source A says Q2 revenue was $48.2 million. Source B (a blog) says $52.0 million. ` +
      `Source A is the company filing; Source B is unattributed. State which figure you would use and why, briefly.`,
    rubric: [
      { id: "picks-filing", description: "Uses the filing figure", pass: (o) => /48\.2/.test(o) },
      {
        id: "explains-precedence",
        description: "Explains source precedence/reliability",
        pass: (o) => /filing|attribut|reliab|authoritative|primary source/i.test(o),
      },
    ],
  },
  // ── Native-file modality: PDF extraction ───────────────────────────
  {
    id: "extract-pdf-native",
    family: "extraction",
    role: "maker",
    modality: "native-file",
    prompt:
      "The attached PDF states: 'Fiscal Q2 revenue: $48.2 million; EBITDA margin 22.4%.' Report both figures exactly.",
    // Minimal valid one-page PDF containing the sentence as text.
    fixture: {
      mimeType: "application/pdf",
      filename: "q2-excerpt.pdf",
      dataBase64: Buffer.from(
        `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
          `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n` +
          `4 0 obj<</Length 90>>stream\nBT /F1 12 Tf 72 720 Td (Fiscal Q2 revenue: $48.2 million; EBITDA margin 22.4%.) Tj ET\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
      ).toString("base64"),
    },
    rubric: [
      { id: "revenue", description: "Revenue figure present", pass: (o) => /48\.2/.test(o) },
      { id: "margin", description: "Margin figure present", pass: (o) => /22\.4/.test(o) },
    ],
  },
];
