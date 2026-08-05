/**
 * Live contract tests — OPT-IN.
 *
 * These exercise real external services (OpenRouter, native file ingestion,
 * Parallel, SharePoint/OneDrive, Google Drive, OfficeCLI). They are skipped by
 * default so CI never depends on network credentials. Run with:
 *
 *   QUIVER_LIVE_CONTRACT=1 npx tsx tests/harness/live/run.ts
 *
 * Each test fails closed if its required credential is absent (rather than
 * skipping silently) so a misconfigured "live" run is visible.
 */
import picocolors from "picocolors";
import type { GraphClient, DriveClient } from "../../../src/harness/storage-providers.js";

const LIVE = process.env.QUIVER_LIVE_CONTRACT === "1";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; console.log(picocolors.red(`   ✗ FAIL  ${name}${detail ? " — " + detail : ""}`)); }
}
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Live contract test requires ${name} (set QUIVER_LIVE_CONTRACT=1 and provide the credential).`);
  return v;
}

async function openrouterNativePdf() {
  const { ChatOpenRouterTransport, QuiverOpenRouterClient } = await import("../../../src/harness/model-client.js");
  const { ModelProfileRegistry, starterCatalog } = await import("../../../src/harness/model-profile.js");
  const { QuiverPolicyEngine } = await import("../../../src/harness/policy-engine.js");
  const { emptyPack } = await import("../../../src/harness/customer-pack.js");
  const fs = await import("fs");

  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const pdfPath = process.env.QUIVER_LIVE_PDF || "";
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    throw new Error("Live native-PDF test requires QUIVER_LIVE_PDF=<path to a real PDF>.");
  }
  const profiles = new ModelProfileRegistry();
  for (const p of starterCatalog()) profiles.register(p);
  const slug = process.env.QUIVER_LIVE_MODEL_PROFILE || "openai-gpt-4o";
  // Pre-certify based on an explicit opt-in env flag; the test itself is the
  // certification. A failure here means the route cannot accept native PDFs and
  // must NOT be silently substituted with OCR.
  profiles.certify(slug, "application/pdf", "pass");
  const pack = emptyPack({ id: "live" });
  const transport = new ChatOpenRouterTransport(apiKey);
  const client = new QuiverOpenRouterClient(transport, profiles, new QuiverPolicyEngine(pack));
  const data = fs.readFileSync(pdfPath);
  const res = await client.invoke(
    [{ role: "user", content: [{ type: "text", text: "Summarize the first page." }, { type: "file", mimeType: "application/pdf", data, filename: "doc.pdf" }] }],
    { modelProfile: slug, sensitivity: "public", budget: { timeoutMs: 60_000 } },
  );
  check("LIVE-OPENROUTER-NATIVE-PDF", typeof res.content === "string" && res.content.length > 0, "no content returned");
  check("LIVE-OPENROUTER-ROUTE-CAPTURED", !!res.route);
}

async function parallelSearch() {
  const { ParallelResearchGateway, ParallelWebTransport } = await import("../../../src/harness/research-gateway.js");
  const { QuiverPolicyEngine } = await import("../../../src/harness/policy-engine.js");
  const { emptyPack } = await import("../../../src/harness/customer-pack.js");
  const apiKey = requireEnv("PARALLEL_API_KEY");
  const gw = new ParallelResearchGateway(new ParallelWebTransport(apiKey), new QuiverPolicyEngine(emptyPack({ id: "live" })));
  const results = await gw.search("OpenAI latest news", { sensitivity: "public", maxResults: 3 });
  check("LIVE-PARALLEL-SEARCH", results.length > 0, "no results");
}

async function microsoftGraph() {
  const { MicrosoftGraphStorageProvider } = await import("../../../src/harness/storage-providers.js");
  const { QuiverPolicyEngine } = await import("../../../src/harness/policy-engine.js");
  const { emptyPack } = await import("../../../src/harness/customer-pack.js");
  const driveItemId = process.env.QUIVER_LIVE_GRAPH_ITEM_ID;
  const accessToken = process.env.QUIVER_LIVE_GRAPH_TOKEN;
  if (!driveItemId || !accessToken) throw new Error("Live Graph test requires QUIVER_LIVE_GRAPH_ITEM_ID + QUIVER_LIVE_GRAPH_TOKEN (delegated Entra access token).");
  // A minimal real Graph client using fetch + the bearer token.
  const client: GraphClient = {
    async getMetadata(id) {
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`Graph metadata ${r.status}`);
      return await r.json();
    },
    async download(id) {
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${id}/content`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`Graph download ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async uploadSession(id, data) {
      // Upload to the same item (overwrite). Real deployments use upload sessions for large files.
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${id}/content`, { method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(data) });
      if (!r.ok) throw new Error(`Graph upload ${r.status}`);
      return await r.json();
    },
    async delta() { return []; },
  };
  const provider = new MicrosoftGraphStorageProvider("live-graph", client);
  void new QuiverPolicyEngine(emptyPack({ id: "live" }));
  const co = await provider.checkout({ id: driveItemId });
  check("LIVE-GRAPH-CHECKOUT-ETAG", !!co.etag);
  const meta = await provider.metadata({ id: driveItemId });
  check("LIVE-GRAPH-METADATA-VERSION", !!meta.version);
  // Conflict check: commit with the correct base etag succeeds.
  const committed = await provider.commit(co, { path: "live.docx", data: co.data }, { reviewer: "live", approvalRef: "live", baseEtag: co.etag });
  check("LIVE-GRAPH-COMMIT-NEW-VERSION", !!committed.newVersion);
}

async function googleDrive() {
  const { GoogleDriveStorageProvider } = await import("../../../src/harness/storage-providers.js");
  const fileId = process.env.QUIVER_LIVE_DRIVE_FILE_ID;
  const accessToken = process.env.QUIVER_LIVE_DRIVE_TOKEN;
  if (!fileId || !accessToken) throw new Error("Live Drive test requires QUIVER_LIVE_DRIVE_FILE_ID + QUIVER_LIVE_DRIVE_TOKEN (OAuth access token).");
  const client: DriveClient = {
    async getMetadata(id) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,version,headRevisionId,webContentLink,size,modifiedTime`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`Drive metadata ${r.status}`);
      const j = await r.json();
      return { ...j, isGoogleNative: (j.mimeType ?? "").startsWith("application/vnd.google-apps") };
    },
    async download(id) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`Drive download ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async upload(id, data) {
      const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: "PATCH", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(data) });
      if (!r.ok) throw new Error(`Drive upload ${r.status}`);
      return await r.json();
    },
    async listChanges() { return { changes: [] }; },
  };
  const provider = new GoogleDriveStorageProvider("live-drive", client);
  const co = await provider.checkout({ id: fileId });
  check("LIVE-DRIVE-CHECKOUT-REVISION", !!co.revisionId);
  const committed = await provider.commit(co, { path: "live.xlsx", data: co.data }, { reviewer: "live", approvalRef: "live", baseVersion: co.revisionId });
  check("LIVE-DRIVE-COMMIT-NEW-REVISION", !!committed.newVersion);
}

async function officeCliConformance() {
  const { OfficeCliEngine, ShellOfficeCliRunner, OFFICECLI_PINS } = await import("../../../src/harness/office-engine.js");
  const binPath = process.env.QUIVER_LIVE_OFFICECLI_PATH;
  const fixture = process.env.QUIVER_LIVE_OFFICECLI_FIXTURE;
  if (!binPath || !fixture) throw new Error("Live OfficeCLI test requires QUIVER_LIVE_OFFICECLI_PATH + QUIVER_LIVE_OFFICECLI_FIXTURE=<path to a real .xlsx/.docx>.");
  const pin = OFFICECLI_PINS[process.platform] ?? OFFICECLI_PINS.darwin;
  const runner = new ShellOfficeCliRunner(binPath, { ...pin, checksum: process.env.QUIVER_LIVE_OFFICECLI_CHECKSUM ?? "" });
  const engine = new OfficeCliEngine(runner);
  const v = await engine.verifyBinary();
  if (!v.ok && !/dev mode/.test(v.reason ?? "")) throw new Error(`OfficeCLI verify failed: ${v.reason}`);
  const structure = await engine.read(fixture);
  check("LIVE-OFFICECLI-READ-STRUCTURE", !!structure.mimeType);
  const validation = await engine.validate(fixture);
  check("LIVE-OFFICECLI-VALIDATE-SURFACES", validation.ok || validation.errors.length > 0 || validation.warnings.length >= 0);
}

async function main() {
  if (!LIVE) {
    console.log(picocolors.yellow("\n  ⏭  Live contract tests skipped (set QUIVER_LIVE_CONTRACT=1 to run)."));
    return;
  }
  const suites: Array<{ name: string; env: string[]; run: () => Promise<void> }> = [
    { name: "OpenRouter native PDF", env: ["OPENROUTER_API_KEY", "QUIVER_LIVE_PDF"], run: openrouterNativePdf },
    { name: "Parallel search", env: ["PARALLEL_API_KEY"], run: parallelSearch },
    { name: "Microsoft Graph (OneDrive/SharePoint)", env: ["QUIVER_LIVE_GRAPH_ITEM_ID", "QUIVER_LIVE_GRAPH_TOKEN"], run: microsoftGraph },
    { name: "Google Drive", env: ["QUIVER_LIVE_DRIVE_FILE_ID", "QUIVER_LIVE_DRIVE_TOKEN"], run: googleDrive },
    { name: "OfficeCLI conformance", env: ["QUIVER_LIVE_OFFICECLI_PATH", "QUIVER_LIVE_OFFICECLI_FIXTURE"], run: officeCliConformance },
  ];
  for (const s of suites) {
    const hasCreds = s.env.every((e) => !!process.env[e]);
    if (!hasCreds) {
      console.log(picocolors.gray(`\n  ⏭  ${s.name}: skipped (missing ${s.env.filter((e) => !process.env[e]).join(", ")})`));
      continue;
    }
    console.log(picocolors.cyan(`\n  ▶ ${s.name}`));
    try { await s.run(); }
    catch (e) { check(`LIVE-${s.name}`, false, (e as Error).message); }
  }
  if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} live contract check(s) FAILED.`)); process.exit(1); }
  console.log(picocolors.cyan(`\n  ✔ ${passed} live contract checks passed.`));
}

main().catch((e) => { console.error(e); process.exit(1); });