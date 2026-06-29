import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getProjectToolsDir } from "../paths.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";
import { z } from "zod";
import { Tool, globalRegistry } from "../registry.js";

export const tool: Tool = {
  name: "create_tool",
  description: "Dynamically creates a new TypeScript tool at runtime and registers it in the agent registry. Use this when you need a custom capability not provided by standard tools.",
  parameters: z.object({
    name: z.string().describe("Alphanumeric and underscores only. Example: 'hash_string'."),
    description: z.string().describe("A detailed description of the tool's behavior and input arguments."),
    code: z.string().describe(
      "The complete TypeScript code for the tool. Must export a 'tool' const object of type Tool. " +
      "Example import statement: `import { Tool } from '../registry.js';`"
    ),
  }),
  execute: async ({ name, description, code }) => {
    // Validate tool name
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`Invalid tool name '${name}'. Only alphanumeric characters and underscores are allowed.`);
    }

    try {
      // US-5.2: generated tools are written to the project-local data folder
      // (~/.quiver/projects/{project}/tools/), NEVER to the application source
      // directories. Writing into src/tools would mutate the shipped product.
      const toolsDir = getProjectToolsDir();
      await fs.mkdir(toolsDir, { recursive: true });
      const filePath = path.join(toolsDir, `${name}.ts`);
      assertToolPathAllowed(filePath, "write");

      // Write the TS source file
      await fs.writeFile(filePath, code, "utf8");

      // US-5.2: write a tool manifest with permissions, timeout, and output
      // limits. The tool is NOT auto-activated — the user must inspect the
      // source and approve the manifest before the tool is loaded.
      const manifestPath = path.join(toolsDir, `${name}.manifest.json`);
      const manifest = {
        tool_name: name,
        description,
        source_file: filePath,
        permissions: {
          file_read: true,
          file_write: false,
          network: false,
          shell: false,
        },
        timeout_ms: 30000,
        output_limit_chars: 10000,
        approved: false,
        created_at: new Date().toISOString(),
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      // Validate the code compiles/loads, but do NOT auto-activate it.
      // The tool remains in a "pending approval" state until the user
      // reviews the source and manifest and explicitly approves it.
      const loaded = await globalRegistry.loadToolFile(filePath);
      if (!loaded) {
        // Clean up invalid code file to avoid configuration issues
        await fs.unlink(filePath).catch(() => {});
        await fs.unlink(manifestPath).catch(() => {});
        throw new Error(`The written tool could not be loaded. Please ensure the code is syntax-valid and exports the 'tool' object correctly.`);
      }

      // Unload the tool immediately — it must not be active until approved.
      // The manifest records its existence; the user approves via the UI/CLI.
      globalRegistry.unregisterTool(name);

      return `Tool '${name}' has been written to ${filePath} with a manifest at ${manifestPath}.\n` +
        `It is pending approval — the tool is NOT active yet.\n` +
        `Review the source and manifest, then approve it to activate.\n` +
        `Manifest: permissions={file_read: true, file_write: false, network: false, shell: false}, timeout=30s, output_limit=10000 chars`;
    } catch (error: any) {
      throw new Error(`Failed to create dynamic tool '${name}': ${error.message}`);
    }
  },
};