/**
 * Regenerates the binary fixtures for the investment-committee-memo demo:
 *
 *   inputs/Model_v12.xlsx          — synthetic operating model (RevenueBuild + P&L)
 *   template/ic-memo-template.docx — firm-style memo shell (styles, standing
 *                                    title, footer with the illustrative label)
 *
 * Both binaries are committed so the demo runs from a clean checkout without
 * this script; run it only when you want to change the fixtures:
 *
 *   npx tsx examples/investment-committee-memo/scripts/build-fixtures.ts
 *
 * Illustrative workflow — synthetic data. Figures are chosen so that:
 *   RevenueBuild!C8 (total FY2025 revenue)      = 48,200,000  → "$48.2 million"
 *   P&L!B8 / P&L!B4 (EBITDA / revenue)          = 0.224       → "22.4%"
 *   48.2 / 40.9 - 1 (vs. the 10-Q prior period) ≈ 17.8%
 */
import * as fs from "node:fs";
import { FOOTER_TEXT, officecli, p, rel } from "./lib.ts";

function batch(file: string, commands: unknown[]): void {
  const res = officecli(["batch", file, "--commands", JSON.stringify(commands)]);
  if (/"success":\s*false|Error:/i.test(res.stdout)) {
    throw new Error(`batch reported a failure for ${file}:\n${res.stdout}`);
  }
}

function buildModel(): void {
  const file = p("inputs", "Model_v12.xlsx");
  fs.rmSync(file, { force: true });
  officecli(["create", file]);

  // --- RevenueBuild sheet (rename the default Sheet1) --------------------
  officecli(["set", file, "/Sheet1", "--prop", "name=RevenueBuild"]);
  const money = "#,##0";
  const rb: Array<[string, string | number, string?]> = [
    ["A1", "Project Alder — Revenue build (synthetic, illustrative)"],
    ["A3", "Product line"],
    ["B3", "FY2024"],
    ["C3", "FY2025"],
    ["A4", "Core platform subscriptions"],
    ["B4", 24_100_000, money],
    ["C4", 28_400_000, money],
    ["A5", "Payments module"],
    ["B5", 8_900_000, money],
    ["C5", 10_300_000, money],
    ["A6", "Data & analytics module"],
    ["B6", 5_200_000, money],
    ["C6", 6_400_000, money],
    ["A7", "Implementation & services"],
    ["B7", 2_700_000, money],
    ["C7", 3_100_000, money],
    ["A8", "Total revenue"],
  ];
  batch(file, [
    ...rb.map(([cell, value, fmt]) => ({
      command: "set",
      path: `/RevenueBuild/${cell}`,
      props: fmt ? { value: String(value), numberFormat: fmt } : { value: String(value) },
    })),
    { command: "set", path: "/RevenueBuild/B8", props: { formula: "=SUM(B4:B7)", numberFormat: money } },
    { command: "set", path: "/RevenueBuild/C8", props: { formula: "=SUM(C4:C7)", numberFormat: money } },
  ]);

  // --- P&L sheet -----------------------------------------------------------
  officecli(["add", file, "/", "--type", "sheet", "--prop", "name=P&L"]);
  batch(file, [
    { command: "set", path: "/P&L/A1", props: { value: "Project Alder — P&L (synthetic, illustrative)" } },
    { command: "set", path: "/P&L/A3", props: { value: "FY2025 (USD)" } },
    { command: "set", path: "/P&L/A4", props: { value: "Revenue" } },
    { command: "set", path: "/P&L/B4", props: { formula: "=RevenueBuild!C8", numberFormat: money } },
    { command: "set", path: "/P&L/A5", props: { value: "Cost of revenue" } },
    { command: "set", path: "/P&L/B5", props: { value: "15900000", numberFormat: money } },
    { command: "set", path: "/P&L/A6", props: { value: "Gross profit" } },
    { command: "set", path: "/P&L/B6", props: { formula: "=B4-B5", numberFormat: money } },
    { command: "set", path: "/P&L/A7", props: { value: "Operating expenses (excl. D&A)" } },
    { command: "set", path: "/P&L/B7", props: { value: "21503200", numberFormat: money } },
    { command: "set", path: "/P&L/A8", props: { value: "EBITDA" } },
    { command: "set", path: "/P&L/B8", props: { formula: "=B6-B7", numberFormat: money } },
    { command: "set", path: "/P&L/A9", props: { value: "EBITDA margin" } },
    { command: "set", path: "/P&L/B9", props: { formula: "=B8/B4", numberFormat: "0.0%" } },
  ]);

  officecli(["close", file]);
  officecli(["validate", file]);
  console.log(`built ${rel(file)}`);
}

function buildTemplate(): void {
  const file = p("template", "ic-memo-template.docx");
  fs.rmSync(file, { force: true });
  // --locale en-US keeps the docDefaults deterministic across host machines.
  officecli(["create", file, "--locale", "en-US"]);

  batch(file, [
    // Firm-style paragraph styles used by the pipeline.
    {
      command: "add",
      parent: "/styles",
      type: "style",
      props: {
        id: "Title", name: "Title", type: "paragraph", basedOn: "Normal",
        size: "26", bold: "true", color: "#1F3864", spaceAfter: "4pt", qFormat: "true",
      },
    },
    {
      command: "add",
      parent: "/styles",
      type: "style",
      props: {
        id: "Subtitle", name: "Subtitle", type: "paragraph", basedOn: "Normal",
        size: "13", color: "#4A5568", spaceAfter: "12pt", qFormat: "true",
      },
    },
    {
      command: "add",
      parent: "/styles",
      type: "style",
      props: {
        id: "Heading1", name: "heading 1", type: "paragraph", basedOn: "Normal", next: "Normal",
        size: "14", bold: "true", color: "#1F3864", spaceBefore: "14pt", spaceAfter: "6pt", qFormat: "true",
      },
    },
    // Standing title line: the memo subject is appended by the pipeline.
    { command: "add", parent: "/body", type: "paragraph", props: { text: "Investment Committee Memorandum", style: "Title" } },
    // Footer carrying the honesty label on every page.
    { command: "add", parent: "/", type: "footer", props: { type: "default", text: FOOTER_TEXT, align: "center" } },
  ]);

  officecli(["close", file]);
  officecli(["validate", file]);
  console.log(`built ${rel(file)}`);
}

buildModel();
buildTemplate();
console.log("fixtures rebuilt.");
