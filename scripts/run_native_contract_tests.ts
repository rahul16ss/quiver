#!/usr/bin/env node
/**
 * Native-file contract tests — the live, opt-in proof behind CapabilityRegistry.
 *
 * For each native-doc profile in the starter catalog, sends a small real file
 * (PDF / DOCX / XLSX, generated locally) containing a code word directly to
 * OpenRouter with the SAME wire shape QuiverOpenRouterClient uses (file
 * content part, ZDR provider pins, file-parser native engine for PDF) and
 * asks the model to read the code word back. A correct answer certifies that
 * (profile, MIME) route; the result persists to
 * ~/.quiver/native-certifications.json where buildProductionRuntime loads it.
 *
 * Costs real money (cents — files are tiny). Requires OPENROUTER_API_KEY.
 *
 * Run: npx tsx scripts/run_native_contract_tests.ts [--profiles slug1,slug2] [--mimes pdf,docx,xlsx]
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  ModelProfileRegistry,
  starterCatalog,
  appendCertification,
  type NativeMime,
} from "../src/harness/model-profile.js";

const CODE_WORD = `QUIVER-CERT-${Math.floor(1000 + Math.random() * 9000)}`;
const CERT_PATH = path.join(os.homedir(), ".quiver", "native-certifications.json");

const MIME_BY_ALIAS: Record<string, NativeMime> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/** A minimal but valid one-page PDF whose page stream draws the code word. */
function makePdf(dir: string): string {
  const text = `BT /F1 24 Tf 72 700 Td (The code word is ${CODE_WORD}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const file = path.join(dir, "cert.pdf");
  fs.writeFileSync(file, body, "binary");
  return file;
}

/** DOCX/XLSX fixtures via officecli — the same engine the product ships with. */
function makeOffice(dir: string, kind: "docx" | "xlsx"): string {
  const bin = process.env.QUIVER_OFFICECLI_PATH || "officecli";
  const file = path.join(dir, `cert.${kind}`);
  execFileSync(bin, ["create", file], { stdio: "pipe", timeout: 30_000 });
  if (kind === "docx") {
    execFileSync(
      bin,
      ["add", file, "/body", "--type", "paragraph", "--prop", `text=The code word is ${CODE_WORD}`],
      { stdio: "pipe", timeout: 30_000 },
    );
  } else {
    execFileSync(
      bin,
      ["set", file, "/Sheet1/A1", "--prop", `value=The code word is ${CODE_WORD}`],
      { stdio: "pipe", timeout: 30_000 },
    );
  }
  return file;
}

async function testProfile(
  apiKey: string,
  modelSlug: string,
  providerOrder: string[],
  mime: NativeMime,
  filePath: string,
): Promise<{ pass: boolean; detail: string }> {
  const data = fs.readFileSync(filePath).toString("base64");
  const body: Record<string, unknown> = {
    model: modelSlug,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Read the attached document and reply with ONLY the code word it contains " +
              "(format QUIVER-CERT-NNNN). Reply with the code word and nothing else.",
          },
          {
            type: "file",
            file: { filename: path.basename(filePath), file_data: `data:${mime};base64,${data}` },
          },
        ],
      },
    ],
    max_tokens: 5000,
    // The same posture QuiverOpenRouterClient pins per request (ADR-001).
    provider: { order: providerOrder, allow_fallbacks: false, data_collection: "deny", zdr: true },
    ...(mime === "application/pdf"
      ? { plugins: [{ id: "file-parser", pdf: { engine: "native" } }] }
      : {}),
  };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    return { pass: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  const json: any = await res.json();
  if (json.error) return { pass: false, detail: JSON.stringify(json.error).slice(0, 200) };
  const answer = String(json.choices?.[0]?.message?.content ?? "");
  const pass = answer.includes(CODE_WORD);
  return {
    pass,
    detail: pass
      ? `read back ${CODE_WORD} (cost $${json.usage?.cost ?? "?"})`
      : `answer did not contain the code word: "${answer.slice(0, 120)}"`,
  };
}

async function main(): Promise<void> {
  const apiKey =
    process.env.OPENROUTER_API_KEY ||
    (await import("../src/secrets/keychain.js")).getCredentialSync("OPENROUTER_API_KEY") ||
    "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY required (env or OS keychain)");

  const registry = new ModelProfileRegistry();
  for (const p of starterCatalog()) registry.register(p);

  const wantProfiles = arg("profiles")?.split(",");
  const wantMimes = (arg("mimes")?.split(",") ?? ["pdf", "docx", "xlsx"]).map((m) => {
    const mime = MIME_BY_ALIAS[m.trim()];
    if (!mime) throw new Error(`unknown mime alias: ${m}`);
    return mime;
  });

  const profiles = registry
    .list()
    .filter((p) => p.nativeFileInput && !p.modelSlug.startsWith("local/"))
    .filter((p) => !wantProfiles || wantProfiles.includes(p.slug));
  if (profiles.length === 0) throw new Error("no matching native-file profiles");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-cert-"));
  const fixtures = new Map<NativeMime, string>();
  for (const mime of wantMimes) {
    if (mime === "application/pdf") fixtures.set(mime, makePdf(dir));
    else if (mime === MIME_BY_ALIAS.docx) fixtures.set(mime, makeOffice(dir, "docx"));
    else if (mime === MIME_BY_ALIAS.xlsx) fixtures.set(mime, makeOffice(dir, "xlsx"));
  }

  console.log(`Code word: ${CODE_WORD}`);
  let failures = 0;
  for (const profile of profiles) {
    for (const [mime, file] of fixtures) {
      process.stdout.write(`${profile.slug} (${profile.modelSlug}) × ${mime.split("/").pop()} … `);
      let result: { pass: boolean; detail: string };
      try {
        result = await testProfile(apiKey, profile.modelSlug, profile.providerOrder, mime, file);
      } catch (err: any) {
        result = { pass: false, detail: String(err?.message ?? err).slice(0, 200) };
      }
      console.log(result.pass ? `PASS — ${result.detail}` : `FAIL — ${result.detail}`);
      if (!result.pass) failures++;
      appendCertification(CERT_PATH, {
        profileSlug: profile.slug,
        modelSlug: profile.modelSlug,
        mime,
        result: result.pass ? "pass" : "fail",
        date: new Date().toISOString(),
        evidence: `code-word round-trip (${result.detail.slice(0, 160)})`,
      });
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nCertifications written to ${CERT_PATH}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
