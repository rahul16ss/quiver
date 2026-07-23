/**
 * DMS export tool — SPEC §9.4. The agent exports a finished deliverable to the
 * firm's document-management system via the DMS framework (`src/export/dms.ts`).
 * No-op (clear message) when no adapter is configured — never a silent success.
 */
import { z } from "zod";
import { Tool } from "../registry.js";
import { getActiveDmsExporter, loadDmsConfig, listDmsExporters } from "../export/dms.js";

export const tool: Tool = {
  name: "dms_export",
  description:
    "Export a finished deliverable to the firm's document-management system (SharePoint, NetDocuments, …). " +
    "Actions: 'export' (upload a local file to the active DMS adapter), 'list' (show configured adapters), 'status'. " +
    "No adapter configured → returns a clear configuration hint, not a silent success.",
  parameters: z.object({
    action: z.enum(["export", "list", "status"]).describe("export|list|status"),
    filePath: z.string().optional().describe("Local path to the file to export (required for 'export')."),
    name: z.string().optional().describe("The document name in the DMS (defaults to the file's basename)."),
    fields: z.record(z.string(), z.string()).optional().describe("Free-form metadata mapped to DMS fields (matter, client, author…)."),
  }),
  async execute(args) {
    loadDmsConfig();
    if (args.action === "list") {
      const list = listDmsExporters();
      return `DMS adapters: ${list.length ? list.map((a) => `${a.id} (${a.configured ? "configured" : "not configured"})`).join(", ") : "none registered"}. Active: ${getActiveDmsExporter()?.id ?? "none — set .quiver/dms.json { active: \"sharepoint\" }"}.`;
    }
    if (args.action === "status") {
      const e = getActiveDmsExporter();
      return e ? `Active DMS: ${e.id} (${e.isConfigured() ? "configured" : "not configured — " + e.configHint()})` : "No active DMS adapter. Configure .quiver/dms.json (e.g. { \"active\": \"sharepoint\" }) and the adapter's env vars.";
    }
    // export
    if (!args.filePath) return "Error: filePath is required for export.";
    const e = getActiveDmsExporter();
    if (!e) return "No active DMS adapter configured. Set .quiver/dms.json { active: \"sharepoint\" } and the adapter's env vars (see dms_export status).";
    const res = await e.export({
      name: args.name || (args.filePath.split("/").pop() || args.filePath),
      deliverablePath: args.filePath,
      fields: args.fields,
    });
    return res.ok ? `✓ ${res.detail}` : `✗ ${res.detail}`;
  },
};