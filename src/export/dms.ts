/**
 * DMS export framework — SPEC §9.4 (Phase 2).
 *
 * Export a finished deliverable to the firm's document-management system
 * (SharePoint, NetDocuments, …). This is the FRAMEWORK; the real adapter for a
 * given firm is configured per engagement (endpoint, auth, site/drive). Each
 * adapter implements `DmsExporter`; the registry resolves the active adapter
 * from `.quiver/dms.json`. When no adapter is configured, export is a no-op
 * with a clear message — never a silent success.
 *
 * The two named adapters document the real integration shape (Microsoft Graph
 * for SharePoint; NetDocuments REST). They perform a real upload when their
 * env/config is set; otherwise they report exactly what's missing.
 */
import * as fs from "fs";
import * as path from "path";

export interface DmsExportResult {
  ok: boolean;
  url?: string; // the DMS URL of the uploaded document, if known
  detail: string;
}

export interface DmsExportMeta {
  name: string; // the document name in the DMS
  deliverablePath: string; // local path to the file being exported
  /** Free-form metadata (matter, client, author…) the firm maps to DMS fields. */
  fields?: Record<string, string>;
}

export interface DmsExporter {
  readonly id: string; // "sharepoint" | "netdocuments" | custom
  /** True when the adapter is fully configured (endpoint + auth present). */
  isConfigured(): boolean;
  /** What's missing to make the adapter usable (shown when not configured). */
  configHint(): string;
  export(meta: DmsExportMeta): Promise<DmsExportResult>;
}

// ─── Registry ──────────────────────────────────────────────────────────

const exporters = new Map<string, DmsExporter>();
let activeId: string | null = null;

export function registerDmsExporter(e: DmsExporter): void {
  exporters.set(e.id, e);
}
export function setActiveDmsExporter(id: string | null): void {
  activeId = id;
}
export function getActiveDmsExporter(): DmsExporter | null {
  if (activeId && exporters.has(activeId)) return exporters.get(activeId)!;
  return null;
}
export function listDmsExporters(): Array<{ id: string; configured: boolean }> {
  return [...exporters.values()].map((e) => ({ id: e.id, configured: e.isConfigured() }));
}

/** Load the active adapter + config from .quiver/dms.json (per-engagement). */
export function loadDmsConfig(configPath?: string): { active: string | null } {
  const p = configPath || path.join(process.cwd(), ".quiver", "dms.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    activeId = raw.active ?? null;
    return { active: activeId };
  } catch {
    return { active: null };
  }
}

// ─── SharePoint (Microsoft Graph) adapter ───────────────────────────────

export class SharePointExporter implements DmsExporter {
  readonly id = "sharepoint";
  constructor(
    private graphEndpoint: string = process.env.SHAREPOINT_GRAPH_ENDPOINT || "",
    private siteId: string = process.env.SHAREPOINT_SITE_ID || "",
    private driveId: string = process.env.SHAREPOINT_DRIVE_ID || "",
    private accessToken: string = process.env.SHAREPOINT_ACCESS_TOKEN || "",
  ) {}
  isConfigured(): boolean {
    return !!(this.graphEndpoint && this.siteId && this.driveId && this.accessToken);
  }
  configHint(): string {
    return "Set SHAREPOINT_GRAPH_ENDPOINT, SHAREPOINT_SITE_ID, SHAREPOINT_DRIVE_ID, SHAREPOINT_ACCESS_TOKEN (Microsoft Graph).";
  }
  async export(meta: DmsExportMeta): Promise<DmsExportResult> {
    if (!this.isConfigured())
      return { ok: false, detail: `SharePoint not configured. ${this.configHint()}` };
    if (!fs.existsSync(meta.deliverablePath))
      return { ok: false, detail: `local file not found: ${meta.deliverablePath}` };
    const buf = fs.readFileSync(meta.deliverablePath);
    const url = `${this.graphEndpoint}/sites/${this.siteId}/drives/${this.driveId}/root:/${encodeURIComponent(meta.name)}:/content`;
    try {
      // Microsoft Graph's simple PUT endpoint is limited to small files.
      // Use an upload session for larger Office deliverables so an ordinary
      // IC memo or workbook does not fail at the DMS boundary.
      if (buf.byteLength > 4 * 1024 * 1024) {
        return await this.uploadLargeFile(url, buf, meta.name);
      }
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: buf,
      });
      if (!res.ok)
        return { ok: false, detail: `SharePoint upload failed: ${res.status} ${res.statusText}` };
      const json: any = await res.json();
      return {
        ok: true,
        url: json?.webUrl,
        detail: `Uploaded to SharePoint: ${json?.webUrl ?? url}`,
      };
    } catch (e: any) {
      return { ok: false, detail: `SharePoint upload error: ${e?.message || e}` };
    }
  }

  private async uploadLargeFile(
    contentUrl: string,
    buf: Buffer,
    name: string,
  ): Promise<DmsExportResult> {
    const sessionUrl = `${contentUrl.replace(/\/content$/, "")}/createUploadSession`;
    const session = await fetch(sessionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": "replace",
          name,
        },
      }),
    });
    if (!session.ok) {
      return {
        ok: false,
        detail: `SharePoint upload session failed: ${session.status} ${session.statusText}`,
      };
    }
    const sessionJson: any = await session.json();
    const uploadUrl = sessionJson?.uploadUrl;
    if (typeof uploadUrl !== "string" || !uploadUrl) {
      return { ok: false, detail: "SharePoint upload session returned no uploadUrl." };
    }

    // Graph requires chunk sizes to be a multiple of 320 KiB.
    const chunkSize = 10 * 320 * 1024;
    let responseJson: any = null;
    for (let start = 0; start < buf.byteLength; start += chunkSize) {
      const end = Math.min(start + chunkSize, buf.byteLength) - 1;
      const chunk = buf.subarray(start, end + 1);
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.byteLength),
          "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
        },
        body: new Uint8Array(chunk),
      });
      if (!response.ok) {
        return {
          ok: false,
          detail: `SharePoint upload chunk failed at bytes ${start}-${end}: ${response.status} ${response.statusText}`,
        };
      }
      responseJson = await response.json().catch(() => null);
    }
    return {
      ok: true,
      url: responseJson?.webUrl,
      detail: `Uploaded to SharePoint with an upload session: ${responseJson?.webUrl ?? name}`,
    };
  }
}

// ─── NetDocuments adapter ──────────────────────────────────────────────

export class NetDocumentsExporter implements DmsExporter {
  readonly id = "netdocuments";
  constructor(
    private cabinetId: string = process.env.NETDOCS_CABINET_ID || "",
    private apiBase: string = process.env.NETDOCS_API_BASE || "",
    private accessToken: string = process.env.NETDOCS_ACCESS_TOKEN || "",
  ) {}
  isConfigured(): boolean {
    return !!(this.cabinetId && this.apiBase && this.accessToken);
  }
  configHint(): string {
    return "Set NETDOCS_CABINET_ID, NETDOCS_API_BASE, NETDOCS_ACCESS_TOKEN (NetDocuments REST).";
  }
  async export(meta: DmsExportMeta): Promise<DmsExportResult> {
    if (!this.isConfigured())
      return { ok: false, detail: `NetDocuments not configured. ${this.configHint()}` };
    if (!fs.existsSync(meta.deliverablePath))
      return { ok: false, detail: `local file not found: ${meta.deliverablePath}` };
    const buf = fs.readFileSync(meta.deliverablePath);
    try {
      const res = await fetch(`${this.apiBase}/cabinets/${this.cabinetId}/documents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/octet-stream",
          "X-Doc-Name": meta.name,
        },
        body: buf,
      });
      if (!res.ok)
        return { ok: false, detail: `NetDocuments upload failed: ${res.status} ${res.statusText}` };
      const json: any = await res.json();
      return {
        ok: true,
        url: json?.url,
        detail: `Uploaded to NetDocuments: ${json?.url ?? json?.id ?? "ok"}`,
      };
    } catch (e: any) {
      return { ok: false, detail: `NetDocuments upload error: ${e?.message || e}` };
    }
  }
}

// Register the built-in adapters (active one resolved from .quiver/dms.json).
registerDmsExporter(new SharePointExporter());
registerDmsExporter(new NetDocumentsExporter());
