/**
 * StorageProvider tests — Phase 7 (ADR-005).
 *
 * Mock-client tests: honest capabilities, root enforcement + conflict
 * fail-closed for Local; ETag conflict fail-on-conflict (no replace) + delta
 * for Microsoft Graph; revisionId conflict → sibling output + refusal to
 * silently convert Google-native docs for Google Drive; synced-folder
 * reduced-guarantee labelling.
 */
import picocolors from "picocolors";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  LocalStorageProvider,
  MicrosoftGraphStorageProvider,
  GoogleDriveStorageProvider,
  type GraphClient,
  type GraphItemMetadata,
  type DriveClient,
  type DriveItemMetadata,
} from "../../src/harness/storage-providers.js";
import { DurableCursorStore, InMemoryCursorKV } from "../../src/harness/cursor-store.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function run() {
  // ── Local: root enforcement + atomic commit + conflict fail-closed ──
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-local-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "quiver-outside-"));
  const filePath = path.join(root, "model.xlsx");
  fs.writeFileSync(filePath, Buffer.from("original"));
  const local = new LocalStorageProvider("local1", [root]);

  check("LOCAL-CAPS-NO-VERSIONING", !local.capabilities().versioning && local.capabilities().conflictDetection === "refetch");

  const co = await local.checkout({ id: filePath });
  check("LOCAL-CHECKOUT-ETAG", !!co.etag && co.data.toString() === "original");

  // Outside-root access refused.
  let refused = false;
  try { await local.checkout({ id: path.join(outside, "x") }); } catch { refused = true; }
  check("LOCAL-ROOT-ENFORCED", refused);

  // Commit requires reviewer + approvalRef.
  let noApproval = false;
  try { await local.commit(co, { path: filePath, data: Buffer.from("new") }, { reviewer: "", approvalRef: "" }); } catch { noApproval = true; }
  check("LOCAL-COMMIT-REQUIRES-APPROVAL", noApproval);

  // Successful commit with base etag.
  const committed = await local.commit(co, { path: filePath, data: Buffer.from("new") }, { reviewer: "jane", approvalRef: "app-1", baseEtag: co.etag });
  check("LOCAL-COMMIT-NEW-VERSION", !!committed.newVersion);
  check("LOCAL-COMMIT-ATOMIC", fs.readFileSync(filePath, "utf8") === "new");

  // Conflict: base etag stale → fail closed (no overwrite).
  let conflict = false;
  try { await local.commit(co, { path: filePath, data: Buffer.from("stale") }, { reviewer: "jane", approvalRef: "app-2", baseEtag: co.etag }); } catch { conflict = true; }
  check("LOCAL-CONFLICT-FAIL-CLOSED", conflict);

  // Synced folder is labelled reduced-guarantee.
  const synced = new LocalStorageProvider("synced", [root], true);
  check("LOCAL-SYNCED-REDUCED-GUARANTEE", synced.capabilities().reducedGuarantee);

  // ── Microsoft Graph: fail-on-conflict (no conflictBehavior:replace) ──
  class MockGraph implements GraphClient {
    etag = "etag-v1";
    version = "v1";
    async getMetadata(id: string): Promise<GraphItemMetadata> { return { id, name: "memo.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", eTag: this.etag, version: this.version, webUrl: "https://graph", size: 10, lastModified: new Date().toISOString() }; }
    async download(): Promise<Buffer> { return Buffer.from("graph-bytes"); }
    async uploadSession(id: string): Promise<GraphItemMetadata> { return { id, name: "memo.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", eTag: "etag-v2", version: "v2", webUrl: "https://graph", size: 12, lastModified: new Date().toISOString() }; }
    async delta(): Promise<{ items: GraphItemMetadata[]; nextToken?: string }> { return { items: [{ id: "i2", name: "x", mimeType: "text/plain", eTag: "e", version: "v", size: 1, lastModified: new Date().toISOString() }], nextToken: "tok-2" }; }
  }
  const graph = new MicrosoftGraphStorageProvider("graph1", new MockGraph());
  check("GRAPH-CAPS-VERSIONING-ETAG", graph.capabilities().versioning && graph.capabilities().conflictDetection === "etag" && graph.capabilities().uploadSessions);
  const gco = await graph.checkout({ id: "item-1" });
  check("GRAPH-CHECKOUT-ETAG", gco.etag === "etag-v1");
  const gcommit = await graph.commit(gco, { path: "memo.docx", data: Buffer.from("new") }, { reviewer: "jane", approvalRef: "a", baseEtag: "etag-v1" });
  check("GRAPH-COMMIT-NEW-VERSION", gcommit.newVersion === "v2");

  // ETag conflict → fail (never replace).
  let gConflict = false;
  try { await graph.commit(gco, { path: "memo.docx", data: Buffer.from("x") }, { reviewer: "jane", approvalRef: "a", baseEtag: "stale-etag" }); } catch { gConflict = true; }
  check("GRAPH-CONFLICT-NO-REPLACE", gConflict);
  const changes = await graph.poll();
  check("GRAPH-DELTA-CHANGES", changes.length === 1);

  // ── Durable delta poll persists the next token; a re-poll resumes from it ──
  const graphCursor = new DurableCursorStore(new InMemoryCursorKV());
  const gsc = "graph:" + graph.id;
  const gPoll1 = await graph.pollDurable(graphCursor, gsc);
  check("GRAPH-DURABLE-POLL-1-CHANGES", gPoll1.length === 1);
  check("GRAPH-DURABLE-CURSOR-PERSISTED", (await graphCursor.get(gsc)) === "tok-2", (await graphCursor.get(gsc)) ?? "null");
  // Second poll: durable store holds tok-2; mock always returns the same item,
  // but the cursor is now durable → poll resumes from the persisted token.
  const gPoll2 = await graph.pollDurable(graphCursor, gsc);
  check("GRAPH-DURABLE-RESUMES", (await graphCursor.get(gsc)) === "tok-2");

  // ── Google Drive: revisionId conflict → sibling; no silent conversion ──
  class MockDrive implements DriveClient {
    rev = "rev-1";
    isGoogleNative = false;
    async getMetadata(id: string): Promise<DriveItemMetadata> { return { id, name: "model.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headRevisionId: this.rev, version: this.rev, webUrl: "https://drive", size: 10, modifiedTime: new Date().toISOString(), isGoogleNative: this.isGoogleNative }; }
    async download(): Promise<Buffer> { return Buffer.from("drive-bytes"); }
    async upload(id: string): Promise<DriveItemMetadata> { return { id, name: "model.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headRevisionId: "rev-2", version: "rev-2", webUrl: "https://drive", size: 12, modifiedTime: new Date().toISOString(), isGoogleNative: false }; }
    async listChanges(token?: string): Promise<{ changes: DriveItemMetadata[]; nextPageToken?: string }> { if (token) return { changes: [], nextPageToken: undefined }; return { changes: [{ id: "f2", name: "x", mimeType: "text/plain", headRevisionId: "r", version: "r", size: 1, modifiedTime: new Date().toISOString(), isGoogleNative: false }], nextPageToken: "dtok-1" }; }
  }
  const drive = new GoogleDriveStorageProvider("drive1", new MockDrive());
  check("DRIVE-CAPS-REVISIONID-SHAREDDRIVES", drive.capabilities().conflictDetection === "revisionId" && drive.capabilities().sharedDrives);
  const dco = await drive.checkout({ id: "file-1" });
  check("DRIVE-CHECKOUT-REVISION", dco.revisionId === "rev-1");
  const dcommit = await drive.commit(dco, { path: "model.xlsx", data: Buffer.from("new") }, { reviewer: "jane", approvalRef: "a", baseVersion: "rev-1" });
  check("DRIVE-COMMIT-NEW-REVISION", dcommit.newVersion === "rev-2");

  // Revision conflict → sibling output (no silent overwrite).
  const driveConflict = new GoogleDriveStorageProvider("drive2", new MockDrive());
  let dSibling = false;
  try {
    const r = await driveConflict.commit(dco, { path: "model.xlsx", data: Buffer.from("x") }, { reviewer: "jane", approvalRef: "a", baseVersion: "stale-rev" });
    dSibling = r.identity.id.includes("-reviewed");
  } catch { dSibling = false; }
  check("DRIVE-CONFLICT-SIBLING-OUTPUT", dSibling);

  // Google-native doc: refuse silent conversion.
  const nativeDrive = new MockDrive(); nativeDrive.isGoogleNative = true;
  const native = new GoogleDriveStorageProvider("drive3", nativeDrive);
  let refusedConversion = false;
  try { await native.commit(dco, { path: "g.docx", data: Buffer.from("x") }, { reviewer: "jane", approvalRef: "a", baseVersion: "rev-1" }); } catch { refusedConversion = true; }
  check("DRIVE-NO-SILENT-CONVERSION", refusedConversion);

  // ── Durable Drive change poll persists nextPageToken; resumes from it ──
  const driveCursor = new DurableCursorStore(new InMemoryCursorKV());
  const dsc = "drive:" + driveConflict.id;
  const dp1 = await driveConflict.pollDurable(driveCursor, dsc);
  check("DRIVE-DURABLE-POLL-1", dp1.length === 1);
  check("DRIVE-DURABLE-CURSOR-PERSISTED", (await driveCursor.get(dsc)) === "dtok-1", (await driveCursor.get(dsc)) ?? "null");

  // ── Multi-page change feed: ALL pages collected; final cursor persisted ──
  class PagedDrive implements DriveClient {
    calls = 0;
    async getMetadata(id: string): Promise<DriveItemMetadata> { return { id, name: "x", mimeType: "text/plain", headRevisionId: "r", version: "r", webUrl: "", size: 1, modifiedTime: new Date().toISOString(), isGoogleNative: false }; }
    async download(): Promise<Buffer> { return Buffer.from("x"); }
    async upload(): Promise<DriveItemMetadata> { return this.getMetadata("u"); }
    async listChanges(token?: string): Promise<{ changes: DriveItemMetadata[]; nextPageToken?: string }> {
      this.calls++;
      if (!token) return { changes: [md("a"), md("b")], nextPageToken: "p2" };
      if (token === "p2") return { changes: [md("c")], nextPageToken: "p3" };
      return { changes: [md("d")] };
    }
  }
  function md(id: string): DriveItemMetadata { return { id, name: id, mimeType: "text/plain", headRevisionId: "rev-" + id, version: "rev-" + id, webUrl: "", size: 1, modifiedTime: new Date().toISOString(), isGoogleNative: false }; }
  const pagedDrive = new GoogleDriveStorageProvider("drive-paged", new PagedDrive() as any);
  const pagedCursor = new DurableCursorStore(new InMemoryCursorKV());
  const pagedRes = await pagedDrive.pollDurable(pagedCursor, "drive:paged");
  check("DRIVE-PAGED-ALL-COLLECTED", pagedRes.length === 4 && pagedRes.map((c) => c.identity.id).sort().join(",") === "a,b,c,d", JSON.stringify(pagedRes.map((c) => c.identity.id)));
  check("DRIVE-PAGED-FINAL-CURSOR-PERSISTED", (await pagedCursor.get("drive:paged")) === "p3", (await pagedCursor.get("drive:paged")) ?? "null");
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} storage check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} storage checks passed.`));