/**
 * Live workflow stress — exercise Quiver on the workflows it claims.
 *
 * Run from repo root: npx tsx scripts/stress_live_workflows.ts
 *
 * A) Credential-free reference demos (deterministic)
 * B) Live --single-turn skill drafts against a tiny local fixture
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(ROOT, "src", "cli.ts");
const WORK = path.join(ROOT, ".scratch", "workflow-stress");
const OUT = path.join(WORK, "out");

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✔" : "✗"} ${name} — ${detail}`);
}

function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** Auto-answer approval prompts (e.g. "a\\n" for approve-all). */
    stdinText?: string;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
      stdio: [opts.stdinText != null ? "pipe" : "ignore", "pipe", "pipe"],
    });
    if (opts.stdinText != null && child.stdin) {
      // Keep feeding approve-all so multi-tool turns don't stall headless.
      const pump = setInterval(() => {
        try {
          child.stdin?.write(opts.stdinText!);
        } catch {
          /* closed */
        }
      }, 500);
      child.on("close", () => clearInterval(pump));
      try {
        child.stdin.write(opts.stdinText);
      } catch {
        /* ignore */
      }
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, stdout, stderr: stderr + "\n[timeout]" });
    }, opts.timeoutMs ?? 180_000);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function ensureFixture() {
  fs.mkdirSync(path.join(WORK, "sources"), { recursive: true });
  fs.mkdirSync(path.join(WORK, ".quiver"), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Engagement must own a valid sensitivity.json or Quiver fail-closes.
  const sensSrc = path.join(ROOT, ".quiver", "sensitivity.json");
  const sensDst = path.join(WORK, ".quiver", "sensitivity.json");
  if (fs.existsSync(sensSrc)) {
    fs.copyFileSync(sensSrc, sensDst);
  } else {
    fs.writeFileSync(
      sensDst,
      JSON.stringify(
        {
          version: 1,
          defaultTier: "mid",
          modelEndpoints: { cloud: "configured", local: "" },
          mnpiPatterns: [
            {
              type: "client_or_project_identifier",
              pattern:
                "\\b(?:Client|Customer|Project)\\s+[A-Z][A-Za-z0-9_-]*\\b",
              replacement: "[IDENTIFIER]",
            },
          ],
          classificationRules: [
            {
              type: "approved_public_material",
              pattern: "\\bapproved public material\\b",
              tier: "low",
              reason: "Marked public.",
            },
          ],
        },
        null,
        2,
      ),
    );
  }

  const notes = path.join(WORK, "sources", "acme_notes.md");
  fs.writeFileSync(
    notes,
    `# ACME Analytics — Working Notes (synthetic)

Company: ACME Analytics Inc. (private)
As of: 2026-08-01
Deal type: Series B investment diligence
Classification: approved public material

## Confirmed financials (management pack, p.12)
- ARR FY2024: $18.4m
- ARR FY2025 (TTM): $24.1m
- YoY ARR growth: 31%
- Gross margin FY2025: 78%
- Net revenue retention: 118%
- Cash: $9.2m
- Monthly burn: $0.85m
- Runway: ~11 months

## Commercial
- Customers: 142 enterprise accounts
- Top customer: 9% of ARR
- Top 10 customers: 41% of ARR
- Competitors: DataForge, Metricly, InsightOps

## Legal / open items
- One pending customer dispute (~$0.4m claim) — OPEN
- SOC 2 Type II: in progress, not completed — OPEN
- Cap table: founder 42%, Series A 35%, ESOP 15%, other 8%

## Regulatory note
Jurisdiction: US
Topic: SEC Marketing Rule for RIAs using third-party performance claims
Citation: 17 CFR 275.206(4)-1
Org current state: uses third-party case studies without documented substantiation file
`,
    "utf8",
  );
  return notes;
}

/** Extract assistant-visible text from --json event stream (not the prompt echo). */
function extractAssistantText(jsonStdout: string): {
  text: string;
  refused?: string;
  skills: string[];
} {
  let text = "";
  let refused: string | undefined;
  const skills: string[] = [];
  for (const line of jsonStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev.type === "context_manifest" && Array.isArray(ev.data?.skillsDetail)) {
        for (const s of ev.data.skillsDetail) {
          if (s?.id) skills.push(String(s.id));
        }
      }
      if (ev.type === "sensitivity_refused") {
        refused = String(ev.data?.reason || "refused");
      }
      if (ev.type === "token" && typeof ev.data === "string") text += ev.data;
      if (ev.type === "token" && typeof ev.data?.text === "string")
        text += ev.data.text;
      if (ev.type === "assistant" && typeof ev.data?.content === "string")
        text += ev.data.content;
      if (ev.type === "done" && ev.data?.refused) {
        refused = refused || "done refused";
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  return { text, refused, skills };
}

function scoreSections(
  text: string,
  required: RegExp[],
  label: string,
): boolean {
  const missing = required.filter((re) => !re.test(text));
  if (text.trim().length < 400) {
    record(label, false, `draft too short (${text.trim().length} chars)`);
    return false;
  }
  if (missing.length) {
    record(
      label,
      false,
      `missing ${missing.length}/${required.length} sections`,
    );
    return false;
  }
  record(
    label,
    true,
    `all ${required.length} sections present (${text.length} chars)`,
  );
  return true;
}

async function runNpmDemo(script: string, expect: RegExp) {
  const r = await run("npm", ["run", script], { timeoutMs: 120_000 });
  const combined = r.stdout + "\n" + r.stderr;
  const ok = r.code === 0 && expect.test(combined);
  record(
    `demo:${script}`,
    ok,
    ok
      ? "passed"
      : `exit=${r.code} tail=${combined.slice(-180).replace(/\s+/g, " ")}`,
  );
}

async function runLiveSkill(
  id: string,
  prompt: string,
  required: RegExp[],
  expectSkillId: string,
) {
  const outFile = path.join(OUT, `${id}.md`);
  const jsonFile = path.join(OUT, `${id}.jsonl`);
  // Strict mode: observe/propose — reads are free; no YOLO. Draft stays in
  // assistant text (no write_file / web / shell).
  const r = await run(
    TSX,
    [CLI, "--json", "--single-turn", prompt],
    {
      cwd: WORK,
      env: {
        QUIVER_CONSENT_GATE: "0",
        QUIVER_AUTONOMY: "tier:observe",
        DOTENV_CONFIG_PATH: path.join(ROOT, ".env"),
      },
      timeoutMs: 420_000,
    },
  );
  fs.writeFileSync(jsonFile, r.stdout, "utf8");
  const parsed = extractAssistantText(r.stdout);
  fs.writeFileSync(outFile, parsed.text || r.stdout + "\n" + r.stderr, "utf8");

  if (r.code === 124) {
    record(`live:${id}`, false, "timed out");
    return;
  }
  if (parsed.refused) {
    record(`live:${id}`, false, `refused: ${parsed.refused}`);
    return;
  }
  const skillLoaded = parsed.skills.some(
    (s) =>
      s === expectSkillId ||
      s.includes(expectSkillId) ||
      expectSkillId.includes(s),
  );
  record(
    `live:${id}:skills-dir`,
    skillLoaded && parsed.skills.length >= 3,
    `loaded=[${parsed.skills.join(", ") || "none"}]`,
  );

  const draftOk = scoreSections(parsed.text, required, `live:${id}:structure`);
  const grounded = /ACME|24\.1|18\.4|17\s*CFR|275\.206/i.test(parsed.text);
  record(
    `live:${id}:fixture-grounded`,
    grounded,
    grounded ? "references fixture facts" : "no fixture facts in draft",
  );
  record(
    `live:${id}:exit`,
    r.code === 0 && draftOk && grounded,
    `exit=${r.code}`,
  );
}

/** Missing sensitivity.json must refuse and exit non-zero. */
async function runRefuseExitProbe() {
  const refuseDir = path.join(WORK, "refuse-probe");
  fs.mkdirSync(path.join(refuseDir, ".quiver"), { recursive: true });
  // Deliberately NO sensitivity.json
  const r = await run(
    TSX,
    [CLI, "--json", "--single-turn", "hello"],
    {
      cwd: refuseDir,
      env: {
        QUIVER_CONSENT_GATE: "0",
        QUIVER_AUTONOMY: "tier:observe",
        DOTENV_CONFIG_PATH: path.join(ROOT, ".env"),
      },
      timeoutMs: 60_000,
    },
  );
  const parsed = extractAssistantText(r.stdout);
  const ok = !!parsed.refused && r.code !== 0;
  record(
    "live:refuse-exit",
    ok,
    ok
      ? `refused=${parsed.refused} exit=${r.code}`
      : `expected refuse+nonzero, got refused=${parsed.refused || "none"} exit=${r.code}`,
  );
}

async function main() {
  console.log("\n══ Quiver live workflow stress ══\n");
  ensureFixture();

  console.log("A) Reference demos (no model)\n");
  await runNpmDemo(
    "demo:ic-memo",
    /All acceptance checks passed|checks:\s*8\/8/i,
  );
  await runNpmDemo("demo:post-earnings", /6\s*\/\s*6/i);
  await runNpmDemo("demo:portfolio-review", /6\s*\/\s*6/i);
  await runNpmDemo("demo:ic-memo:live", /Live-draft demo passed/i);

  console.log("\nB) Live skill workflows (Vertex + fixture)\n");

  await runLiveSkill(
    "investment-brief",
    [
      "Use the investment-brief skill.",
      "This is approved public material.",
      "Read ONLY sources/acme_notes.md.",
      "Do not use web search or browse.",
      "Do not call write_file or any write tool — put the full draft in your reply text only.",
      "Write a concise markdown investment brief for ACME Analytics Series B.",
      "Use Confirmed: / Estimated: / Analyst inference: / OPEN-Q labels.",
      "Include these section headings exactly:",
      "## Header",
      "## Investment Thesis",
      "## Company Overview",
      "## Financial Analysis",
      "## Competitive Landscape",
      "## Risk Factors",
      "## Valuation",
      "## Recommendation",
      "Cite the local file path for every financial figure.",
    ].join(" "),
    [
      /##\s*Header/i,
      /##\s*Investment Thesis/i,
      /##\s*Company Overview/i,
      /##\s*Financial Analysis/i,
      /##\s*Competitive Landscape/i,
      /##\s*Risk Factors/i,
      /##\s*Valuation/i,
      /##\s*Recommendation/i,
    ],
    "investment-brief",
  );

  await runLiveSkill(
    "due-diligence",
    [
      "Use the due-diligence skill.",
      "This is approved public material.",
      "Read ONLY sources/acme_notes.md.",
      "Do not use web search.",
      "Do not call write_file — put the full draft in your reply text only.",
      "Write a markdown due diligence draft for ACME Analytics (Series B).",
      "Include headings exactly:",
      "## Header",
      "## Executive Summary",
      "## Financial DD",
      "## Legal DD",
      "## Commercial DD",
      "## Red Flags",
      "## Open Questions",
      "## Sources",
      "Every red flag must include what / why concerning / source.",
    ].join(" "),
    [
      /##\s*Header/i,
      /##\s*Executive Summary/i,
      /##\s*Financial DD/i,
      /##\s*Legal DD/i,
      /##\s*Commercial DD/i,
      /##\s*Red Flags/i,
      /##\s*Open Questions/i,
      /##\s*Sources/i,
    ],
    "due-diligence",
  );

  await runLiveSkill(
    "regulatory-summary",
    [
      "Use the regulatory-summary skill.",
      "This is approved public material.",
      "Read ONLY sources/acme_notes.md.",
      "Do not use web search.",
      "Do not call write_file — put the full draft in your reply text only.",
      "Write a markdown regulatory summary about the SEC Marketing Rule issue in the notes.",
      "Include headings exactly:",
      "## Header",
      "## Scope",
      "## Key Requirements",
      "## Current State Assessment",
      "## Gap Analysis",
      "## Recommendations",
      "## Sources",
      "Cite 17 CFR 275.206(4)-1.",
      "Add disclaimer that this is not legal advice.",
    ].join(" "),
    [
      /##\s*Header/i,
      /##\s*Scope/i,
      /##\s*Key Requirements/i,
      /##\s*Current State Assessment/i,
      /##\s*Gap Analysis/i,
      /##\s*Recommendations/i,
      /##\s*Sources/i,
      /legal advice/i,
    ],
    "regulatory-summary",
  );

  console.log("\nC) Refuse-exit probe (fail-closed)\n");
  await runRefuseExitProbe();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n══ ${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `, ${failed.length} failed` : "") +
      " ══\n",
  );
  console.log(`Drafts: ${OUT}`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
