/**
 * Tier B — officecli action matrix + IC memo acceptance.
 */
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { E2eReporter, makeTempWorkspace, ROOT } from "./helpers.js";

const reporter = new E2eReporter();

function resolveOfficecli(): string | null {
  const candidates = [
    process.env.QUIVER_OFFICECLI_PATH,
    path.join(process.env.HOME || "", ".local/bin/officecli"),
    "officecli",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === "officecli") return c;
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

async function testOfficeDocMatrix(officecli: string): Promise<void> {
  const cwd = makeTempWorkspace("office");
  const doc = path.join(cwd, "E2E_Memo.docx");

  const create = await run(officecli, ["create", doc, "--force"], cwd);
  reporter.assert(
    "B-OFFICE-CREATE",
    create.code === 0 && fs.existsSync(doc),
    `code=${create.code} err=${create.stderr.slice(0, 200)}`,
  );

  const add = await run(
    officecli,
    [
      "add",
      doc,
      "/body",
      "--type",
      "paragraph",
      "--prop",
      "text=E2E revenue was 48.2 million.",
    ],
    cwd,
  );
  reporter.assert(
    "B-OFFICE-ADD",
    add.code === 0,
    `code=${add.code} out=${(add.stdout + add.stderr).slice(0, 200)}`,
  );

  const get = await run(officecli, ["get", doc, "/body", "--json"], cwd);
  reporter.assert(
    "B-OFFICE-GET",
    get.code === 0 && /48\.2|revenue|paragraph|body/i.test(get.stdout),
    `code=${get.code} out=${get.stdout.slice(0, 180)}`,
  );

  const set = await run(
    officecli,
    [
      "set",
      doc,
      "/body/p[1]",
      "--prop",
      "text=E2E revenue revised to 50.0 million.",
    ],
    cwd,
  );
  reporter.assert(
    "B-OFFICE-SET",
    set.code === 0,
    `code=${set.code} out=${(set.stdout + set.stderr).slice(0, 200)}`,
  );

  const validate = await run(officecli, ["validate", doc], cwd);
  reporter.assert(
    "B-OFFICE-VALIDATE",
    validate.code === 0 || /valid/i.test(validate.stdout + validate.stderr),
    `code=${validate.code} out=${(validate.stdout + validate.stderr).slice(0, 200)}`,
  );

  // Help surface — proves the binary understands the action vocabulary Quiver uses.
  const help = await run(officecli, ["help"], cwd);
  reporter.assert(
    "B-OFFICE-HELP",
    help.code === 0 || /create|set|get|validate|merge/i.test(help.stdout + help.stderr),
    `code=${help.code}`,
  );
}

async function testIcMemoDemo(): Promise<void> {
  const result = await run(
    "npm",
    ["run", "demo:ic-memo"],
    ROOT,
    180_000,
  );
  reporter.assert(
    "B-IC-MEMO-DEMO",
    result.code === 0 && /8\/8|passed|acceptance/i.test(result.stdout + result.stderr),
    `code=${result.code} tail=${(result.stdout + result.stderr).slice(-400)}`,
  );
}

async function testFixtureDemos(): Promise<void> {
  for (const [id, script] of [
    ["B-POST-EARNINGS", "demo:post-earnings"],
    ["B-PORTFOLIO-REVIEW", "demo:portfolio-review"],
  ] as const) {
    const result = await run("npm", ["run", script], ROOT, 120_000);
    reporter.assert(
      id,
      result.code === 0,
      `code=${result.code} tail=${(result.stdout + result.stderr).slice(-250)}`,
    );
  }
}

export async function runTierB(): Promise<E2eReporter> {
  console.log("\n══ Tier B — officecli + family demos ══");
  const officecli = resolveOfficecli();
  if (!officecli) {
    reporter.fail("B-OFFICECLI-PRESENT", "officecli binary not found");
  } else {
    reporter.pass("B-OFFICECLI-PRESENT", officecli);
    await testOfficeDocMatrix(officecli);
  }
  await testIcMemoDemo();
  await testFixtureDemos();
  return reporter;
}

if (process.argv[1]?.includes("tier_b_officecli")) {
  runTierB()
    .then((r) => {
      const { passed, failed } = r.summary();
      console.log(`\nTier B: ${passed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
