/**
 * Episodic examples store tool — SPEC §7.4. The agent (or user via slash
 * command) promotes a praised deliverable into a retrievable example, lists
 * the store, or removes one. Loaded examples enter context as episodic memory
 * (visible/editable/excludable in the consent gate, §6 layer B).
 */
import { z } from "zod";
import { Tool } from "../registry.js";
import { promoteExample, listExamples, removeExample, loadExampleContext } from "../memory/examples_store.js";

export const tool: Tool = {
  name: "examples",
  description:
    "Episodic examples store (SPEC §7.4): promote a praised deliverable into a retrievable example the agent consults on future runs. " +
    "Actions: 'promote' (capture structure + provenance), 'list' (show the store), 'remove' <id>, 'context' (the loaded examples as episodic memory).",
  parameters: z.object({
    action: z.enum(["promote", "list", "remove", "context"]).describe("promote|list|remove|context"),
    filePath: z.string().optional().describe("Path to the finished deliverable to promote (required for 'promote')."),
    note: z.string().optional().describe("Why this deliverable is a good example (required for 'promote')."),
    id: z.string().optional().describe("Example id to remove (required for 'remove')."),
  }),
  async execute(args) {
    if (args.action === "list") {
      const list = listExamples();
      return list.length
        ? `Examples store (${list.length}): ${list.map((e) => `${e.id} — ${e.name} (${e.kind}, ${e.provenance})`).join("\n")}`
        : "Examples store is empty. Promote a deliverable with action 'promote'.";
    }
    if (args.action === "context") {
      const ctx = loadExampleContext();
      return ctx || "No promoted examples loaded into context.";
    }
    if (args.action === "remove") {
      if (!args.id) return "Error: id is required for remove.";
      return removeExample(args.id) ? `Removed example ${args.id}.` : `No example with id ${args.id}.`;
    }
    // promote
    if (!args.filePath) return "Error: filePath is required for promote.";
    if (!args.note) return "Error: note (why this is a good example) is required for promote.";
    const rec = promoteExample(args.filePath, args.note);
    return rec
      ? `✓ Promoted example: ${rec.id} — ${rec.name} (${rec.kind}). ${rec.provenance}. Structure captured (${rec.structure.length} chars).`
      : `✗ Could not promote (file not found: ${args.filePath}).`;
  },
};