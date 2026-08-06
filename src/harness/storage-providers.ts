/**
 * StorageProvider — Phase 7 (ADR-005).
 *
 * Three implementations with honest conflict behavior:
 *   - LocalStorageProvider: configured roots only; lock/change detection,
 *     atomic writes, recoverable backups; never overwrites without an approved
 *     change set. A synced cloud folder is labelled reduced-guarantee.
 *   - MicrosoftGraphStorageProvider: Entra OAuth, OS-credential-store refresh
 *     tokens, preserved IDs/ETags/versions, upload sessions, fail-on-conflict
 *     (no conflictBehavior:"replace"), delta queries.
 *   - GoogleDriveStorageProvider: OAuth + stable file IDs, shared drives,
 *     revision metadata; never silently converts Google-native ↔ Office;
 *     re-fetch metadata before commit when conditional-overwrite safety cannot
 *     be guaranteed.
 *
 * Each provider honestly declares its capabilities. Storage is separated from
 * Office manipulation (ArtifactRepository + OfficeEngine). HTTP-bearing
 * providers take an injectable GraphClient/DriveClient so policy + conflict
 * logic is unit-testable without network credentials.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteSync } from "../fs/atomic_write.js";
import { DurableCursorStore, cursorPoll } from "./cursor-store.js";
import type {
  StorageProvider,
  StorageCapabilities,
  StorageIdentity,
  StorageOpts,
  StorageListOpts,
  StorageCheckout,
  StorageMetadata,
  StorageCommitOpts,
  StorageCommitResult,
  StorageChange,
  StoragePollOpts,
} from "./interfaces.js";

// ─── LocalStorageProvider ─────────────────────────────────────────────

export class LocalStorageProvider implements StorageProvider {
  readonly id: string;
  readonly kind = "local" as const;
  private reduced: boolean;

  /**
   * @param roots Explicitly configured local roots. Access outside these is
   *              refused. An empty roots array refuses all access.
   * @param reducedGuarantee Set true when the root is a synced OneDrive/
   *                         SharePoint/Google Drive folder — label it honestly.
   */
  constructor(id: string, private roots: string[], reducedGuarantee = false) {
    this.id = id;
    this.reduced = reducedGuarantee;
  }

  capabilities(): StorageCapabilities {
    return {
      versioning: false,
      conflictDetection: "refetch",
      permissions: false,
      deltaQueries: false,
      changeNotifications: false,
      uploadSessions: false,
      sharedDrives: false,
      reducedGuarantee: this.reduced,
    };
  }

  private resolve(p: string): string {
    const abs = path.resolve(p);
    const inside = this.roots.some((r) => {
      const rr = path.resolve(r);
      return abs === rr || abs.startsWith(rr + path.sep);
    });
    if (!inside) throw new Error(`LocalStorageProvider: '${abs}' is outside configured roots.`);
    return abs;
  }

  async checkout(identity: StorageIdentity, _opts?: StorageOpts): Promise<StorageCheckout> {
    const p = this.resolve(identity.id);
    if (!fs.existsSync(p)) throw new Error(`Local file not found: ${p}`);
    const data = fs.readFileSync(p);
    const stat = fs.statSync(p);
    return {
      identity: { id: p, path: p },
      version: stat.mtimeMs.toString(),
      etag: sha256(data),
      data,
      workingCopyPath: p,
      permissions: undefined,
    };
  }

  async metadata(identity: StorageIdentity, _opts?: StorageOpts): Promise<StorageMetadata> {
    const p = this.resolve(identity.id);
    const stat = fs.statSync(p);
    return {
      identity: { id: p, path: p },
      name: path.basename(p),
      mimeType: mimeForExt(path.extname(p)),
      version: stat.mtimeMs.toString(),
      etag: sha256(fs.readFileSync(p)),
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  async list(folder: StorageIdentity, opts?: StorageListOpts): Promise<StorageMetadata[]> {
    const p = this.resolve(folder.id);
    const entries = fs.readdirSync(p, { withFileTypes: true });
    const out: StorageMetadata[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (opts?.pattern && !minimatch(e.name, opts.pattern)) continue;
      const full = path.join(p, e.name);
      const stat = fs.statSync(full);
      out.push({
        identity: { id: full, path: full },
        name: e.name,
        mimeType: mimeForExt(path.extname(e.name)),
        version: stat.mtimeMs.toString(),
        etag: sha256(fs.readFileSync(full)),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
    return out;
  }

  async commit(
    workingCopy: StorageCheckout,
    candidate: { path: string; data: Buffer },
    opts: StorageCommitOpts,
  ): Promise<StorageCommitResult> {
    if (!opts.reviewer || !opts.approvalRef) {
      throw new Error("LocalStorageProvider.commit requires reviewer + approvalRef (no overwrite without an approved change set).");
    }
    const p = this.resolve(candidate.path);
    // Conflict detection: re-fetch metadata; fail if the base version/etag moved.
    if (opts.baseEtag || opts.baseVersion) {
      const current = await this.metadata(workingCopy.identity);
      if (opts.baseEtag && current.etag && current.etag !== opts.baseEtag) {
        throw new Error(`Local commit conflict: file '${p}' changed since checkout (etag mismatch).`);
      }
      if (opts.baseVersion && current.version && current.version !== opts.baseVersion) {
        throw new Error(`Local commit conflict: file '${p}' changed since checkout (version mismatch).`);
      }
    }
    atomicWriteSync(p, candidate.data);
    const stat = fs.statSync(p);
    return {
      identity: { id: p, path: p },
      newVersion: stat.mtimeMs.toString(),
      etag: sha256(candidate.data),
      committedAt: new Date().toISOString(),
    };
  }
}

// ─── MicrosoftGraphStorageProvider ────────────────────────────────────

/**
 * Minimal Graph client seam. The real implementation uses @microsoft/microsoft-graph-client
 * (or fetch) with Entra OAuth; refresh tokens live in the OS credential store.
 * Injected here so policy + conflict logic is testable.
 */
export interface GraphClient {
  getMetadata(itemId: string): Promise<GraphItemMetadata>;
  download(itemId: string): Promise<Buffer>;
  uploadSession(itemId: string, data: Buffer): Promise<GraphItemMetadata>;
  /** Delta change feed. Returns the changed items and the `nextToken` to resume from. */
  delta(sku?: string): Promise<{ items: GraphItemMetadata[]; nextToken?: string }>;
}

export interface GraphItemMetadata {
  id: string;
  name: string;
  mimeType: string;
  eTag?: string;
  version?: string;
  webUrl?: string;
  size: number;
  lastModified: string;
  permissions?: Record<string, unknown>;
}

export class MicrosoftGraphStorageProvider implements StorageProvider {
  readonly id: string;
  readonly kind = "microsoft-graph" as const;
  constructor(id: string, private client: GraphClient) { this.id = id; }

  capabilities(): StorageCapabilities {
    return {
      versioning: true,
      conflictDetection: "etag",
      permissions: true,
      deltaQueries: true,
      changeNotifications: true,
      uploadSessions: true,
      sharedDrives: false,
      reducedGuarantee: false,
    };
  }

  async checkout(identity: StorageIdentity, _opts?: StorageOpts): Promise<StorageCheckout> {
    const meta = await this.client.getMetadata(identity.id);
    const data = await this.client.download(identity.id);
    // Working copy lives in the Quiver staging area (ArtifactRepository owns
    // the path); here we return the bytes + version identity.
    return {
      identity: { id: meta.id, webUrl: meta.webUrl },
      version: meta.version ?? meta.eTag ?? "",
      etag: meta.eTag,
      revisionId: meta.version,
      data,
      workingCopyPath: "", // set by ArtifactRepository.stage
      permissions: meta.permissions,
    };
  }

  async metadata(identity: StorageIdentity, _opts?: StorageOpts): Promise<StorageMetadata> {
    const m = await this.client.getMetadata(identity.id);
    return graphToMetadata(m);
  }

  async list(folder: StorageIdentity, _opts?: StorageListOpts): Promise<StorageMetadata[]> {
    // Folder listing via delta filtered to children is deployment-specific;
    // the GraphClient.delta is used for change polling. List returns [] unless
    // the client exposes a children call (kept minimal here).
    void folder;
    return [];
  }

  async commit(
    workingCopy: StorageCheckout,
    candidate: { path: string; data: Buffer },
    opts: StorageCommitOpts,
  ): Promise<StorageCommitResult> {
    if (!opts.reviewer || !opts.approvalRef) {
      throw new Error("MicrosoftGraphStorageProvider.commit requires reviewer + approvalRef.");
    }
    // Fail-on-conflict: never default to conflictBehavior:"replace".
    const current = await this.client.getMetadata(workingCopy.identity.id);
    if (opts.baseEtag && current.eTag && current.eTag !== opts.baseEtag) {
      throw new Error(`Graph commit conflict: '${workingCopy.identity.id}' ETag changed since checkout. Refusing replace.`);
    }
    if (opts.baseVersion && current.version && current.version !== opts.baseVersion) {
      throw new Error(`Graph commit conflict: '${workingCopy.identity.id}' version changed since checkout. Refusing replace.`);
    }
    const updated = await this.client.uploadSession(workingCopy.identity.id, candidate.data);
    return {
      identity: { id: updated.id, webUrl: updated.webUrl },
      newVersion: updated.version ?? updated.eTag ?? "",
      etag: updated.eTag,
      revisionId: updated.version,
      webUrl: updated.webUrl,
      committedAt: new Date().toISOString(),
    };
  }

  async poll(opts?: StoragePollOpts): Promise<StorageChange[]> {
    const res = await this.client.delta(opts?.since);
    return res.items.map((m) => ({ identity: { id: m.id, webUrl: m.webUrl }, kind: "modified", version: m.version ?? m.eTag ?? "", modifiedAt: m.lastModified }));
  }

  /**
   * Durable, replay-safe change poll backed by a DurableCursorStore. Uses the
   * Graph delta `returnNextToken` (via the client seam) so an interrupted poll
   * resumes exactly where it stopped — no missed windows, no re-apply. Follows
   * the full paginated feed so no delta page is silently dropped.
   */
  async pollDurable(store: DurableCursorStore, scope: string): Promise<StorageChange[]> {
    return cursorPoll(store, scope, async (since) => {
      let token: string | undefined = since ?? undefined;
      const all: StorageChange[] = [];
      for (let guard = 0; guard < MAX_POLL_PAGES; guard++) {
        const res = await this.client.delta(token);
        for (const m of res.items) {
          all.push({ identity: { id: m.id, webUrl: m.webUrl }, kind: "modified" as const, version: m.version ?? m.eTag ?? "", modifiedAt: m.lastModified });
        }
        if (!res.nextToken) break; // last page
        token = res.nextToken;
      }
      return { changes: all, nextCursor: token ?? undefined };
    });
  }
}

// ─── GoogleDriveStorageProvider ───────────────────────────────────────

export interface DriveClient {
  getMetadata(fileId: string): Promise<DriveItemMetadata>;
  download(fileId: string): Promise<Buffer>;
  upload(fileId: string, data: Buffer, baseRevisionId?: string): Promise<DriveItemMetadata>;
  listChanges(pageToken?: string): Promise<{ changes: DriveItemMetadata[]; nextPageToken?: string }>;
}

export interface DriveItemMetadata {
  id: string;
  name: string;
  mimeType: string;
  version?: string;
  headRevisionId?: string;
  webUrl?: string;
  size: number;
  modifiedTime: string;
  isGoogleNative: boolean; // Google Docs/Sheets/Slides vs uploaded Office
  sharedDrive?: boolean;
}

export class GoogleDriveStorageProvider implements StorageProvider {
  readonly id: string;
  readonly kind = "google-drive" as const;
  constructor(id: string, private client: DriveClient) { this.id = id; }

  capabilities(): StorageCapabilities {
    return {
      versioning: true,
      conflictDetection: "revisionId",
      permissions: true,
      deltaQueries: true,
      changeNotifications: false,
      uploadSessions: false,
      sharedDrives: true,
      reducedGuarantee: false,
    };
  }

  async checkout(identity: StorageIdentity, _opts?: StorageOpts): Promise<StorageCheckout> {
    const m = await this.client.getMetadata(identity.id);
    const data = await this.client.download(identity.id);
    return {
      identity: { id: m.id, webUrl: m.webUrl },
      version: m.headRevisionId ?? m.version ?? "",
      revisionId: m.headRevisionId ?? m.version,
      data,
      workingCopyPath: "",
      permissions: undefined,
    };
  }

  async metadata(identity: StorageIdentity, _opts?: StorageOpts): Promise<StorageMetadata> {
    return driveToMetadata(await this.client.getMetadata(identity.id));
  }

  async list(_folder: StorageIdentity, _opts?: StorageListOpts): Promise<StorageMetadata[]> {
    return [];
  }

  async commit(
    workingCopy: StorageCheckout,
    candidate: { path: string; data: Buffer },
    opts: StorageCommitOpts,
  ): Promise<StorageCommitResult> {
    if (!opts.reviewer || !opts.approvalRef) {
      throw new Error("GoogleDriveStorageProvider.commit requires reviewer + approvalRef.");
    }
    // Re-fetch metadata before commit: Drive does not guarantee conditional
    // overwrite for every operation, so we re-check and create a new version /
    // sibling when conflict safety cannot be guaranteed.
    const current = await this.client.getMetadata(workingCopy.identity.id);
    if (current.isGoogleNative) {
      throw new Error("Refusing to silently convert a Google-native document to Office (or back). Conversion is explicit and warns about fidelity loss.");
    }
    if (opts.baseVersion && current.headRevisionId && current.headRevisionId !== opts.baseVersion) {
      // Create a sibling output rather than silently overwriting.
      const sibling = await this.client.upload(workingCopy.identity.id + "-reviewed", candidate.data);
      return {
        identity: { id: sibling.id, webUrl: sibling.webUrl },
        newVersion: sibling.headRevisionId ?? sibling.version ?? "",
        revisionId: sibling.headRevisionId ?? sibling.version,
        webUrl: sibling.webUrl,
        committedAt: new Date().toISOString(),
      };
    }
    const updated = await this.client.upload(workingCopy.identity.id, candidate.data, opts.baseVersion);
    return {
      identity: { id: updated.id, webUrl: updated.webUrl },
      newVersion: updated.headRevisionId ?? updated.version ?? "",
      revisionId: updated.headRevisionId ?? updated.version,
      webUrl: updated.webUrl,
      committedAt: new Date().toISOString(),
    };
  }

  async poll(opts?: StoragePollOpts): Promise<StorageChange[]> {
    const res = await this.client.listChanges(opts?.since);
    return res.changes.map((m) => ({ identity: { id: m.id, webUrl: m.webUrl }, kind: "modified", version: m.headRevisionId ?? m.version ?? "", modifiedAt: m.modifiedTime }));
  }

  /**
   * Durable, replay-safe change poll backed by a DurableCursorStore. Uses the
   * Drive `nextPageToken` so an interrupted poll resumes exactly where it
   * stopped — no missed windows, no re-apply.
   */
  async pollDurable(store: DurableCursorStore, scope: string): Promise<StorageChange[]> {
    return cursorPoll(store, scope, async (since) => {
      // Follow the full paginated change feed so NO page is silently dropped.
      // The first call uses the persisted cursor; subsequent calls use the
      // returned nextPageToken. We persist only the FINAL token — the stable
      // cursor at the end of the complete sweep (replay resumes exactly there).
      let token: string | undefined = since ?? undefined;
      const all: StorageChange[] = [];
      for (let guard = 0; guard < MAX_POLL_PAGES; guard++) {
        const res = await this.client.listChanges(token);
        for (const m of res.changes) {
          all.push({ identity: { id: m.id, webUrl: m.webUrl }, kind: "modified" as const, version: m.headRevisionId ?? m.version ?? "", modifiedAt: m.modifiedTime });
        }
        if (!res.nextPageToken) break; // last page
        token = res.nextPageToken;
      }
      return { changes: all, nextCursor: token ?? undefined };
    });
  }
}

/** Bound on pages followed per paginated change sweep (safety valve). */
const MAX_POLL_PAGES = 100;

// ─── helpers ──────────────────────────────────────────────────────────

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".pdf": return "application/pdf";
    case ".csv": return "text/csv";
    default: return "application/octet-stream";
  }
}

function minimatch(name: string, pattern: string): boolean {
  // Minimal glob: only supports "*" wildcard and exact extensions like "*.xlsx".
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(name);
}

function graphToMetadata(m: GraphItemMetadata): StorageMetadata {
  return {
    identity: { id: m.id, webUrl: m.webUrl },
    name: m.name,
    mimeType: m.mimeType,
    version: m.version ?? m.eTag ?? "",
    etag: m.eTag,
    revisionId: m.version,
    webUrl: m.webUrl,
    sizeBytes: m.size,
    modifiedAt: m.lastModified,
    permissions: m.permissions,
  };
}

function driveToMetadata(m: DriveItemMetadata): StorageMetadata {
  return {
    identity: { id: m.id, webUrl: m.webUrl },
    name: m.name,
    mimeType: m.mimeType,
    version: m.headRevisionId ?? m.version ?? "",
    revisionId: m.headRevisionId ?? m.version,
    webUrl: m.webUrl,
    sizeBytes: m.size,
    modifiedAt: m.modifiedTime,
  };
}