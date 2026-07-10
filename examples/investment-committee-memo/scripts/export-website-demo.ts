/**
 * Copies the shareable demo artifacts into website-export/ for use on the
 * public site. Run from the repo root, after `npm run demo:ic-memo`:
 *
 *   npm run export:website-demo
 *
 * Before copying it verifies, and fails loudly if any exported file:
 *   1. contains an absolute local path ("/Users/") or a secret-looking string;
 *   2. (text artifacts) is missing the illustrative label.
 *
 * Illustrative workflow — synthetic data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LABEL, OUTPUT, p } from "./lib.ts";

const EXPORT_DIR = p("website-export");

interface ExportItem {
  src: string; // relative to example dir
  text: boolean; // text artifacts get label + secret-pattern checks
}

const ITEMS: ExportItem[] = [
  { src: OUTPUT.evidenceJson, text: true },
  { src: OUTPUT.evidenceHtml, text: true },
  { src: OUTPUT.reviewChecklist, text: true },
  { src: OUTPUT.runRecord, text: true },
  { src: "screenshots/evidence-report.png", text: false },
];

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["api key / token / password assignment", /\b(api[_-]?key|secret|token|password|passwd|credential)\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+]{8,}/i],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
];

function fail(msg: string): never {
  console.error(`EXPORT BLOCKED: ${msg}`);
  process.exit(1);
}

function verify(item: ExportItem): void {
  const abs = p(item.src);
  if (!fs.existsSync(abs)) fail(`${item.src} does not exist — run \`npm run demo:ic-memo\` first`);

  // 1a. No absolute local paths, checked on raw bytes so it also covers the PNG.
  const bytes = fs.readFileSync(abs);
  if (bytes.includes("/Users/")) fail(`${item.src} contains an absolute local path ("/Users/")`);
  if (bytes.includes("C:\\Users\\")) fail(`${item.src} contains an absolute local path ("C:\\Users\\")`);

  if (item.text) {
    const text = bytes.toString("utf8");
    // 1b. No secret-looking strings.
    for (const [label, re] of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) fail(`${item.src} matches secret pattern "${label}": ${m[0].slice(0, 40)}...`);
    }
    // 2. Illustrative label present.
    if (!text.includes(LABEL)) fail(`${item.src} is missing the label "${LABEL}"`);
  }
  console.log(`  verified ${item.src}${item.text ? " (paths, secrets, label)" : " (paths)"}`);
}

console.log("Website export — Illustrative workflow, synthetic data\n");
for (const item of ITEMS) verify(item);

fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });
for (const item of ITEMS) {
  const dest = path.join(EXPORT_DIR, path.basename(item.src));
  fs.copyFileSync(p(item.src), dest);
  console.log(`  exported website-export/${path.basename(item.src)}`);
}
console.log(`\nExport complete: ${ITEMS.length} files in examples/investment-committee-memo/website-export/`);
