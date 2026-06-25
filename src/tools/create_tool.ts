import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
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
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const filePath = path.join(currentDir, `${name}.ts`);

      // Write the TS file
      await fs.writeFile(filePath, code, "utf8");

      // Load it into the dynamic registry
      const loaded = await globalRegistry.loadToolFile(filePath);
      if (!loaded) {
        // Clean up invalid code file to avoid configuration issues
        await fs.unlink(filePath).catch(() => {});
        throw new Error(`The written tool could not be loaded. Please ensure the code is syntax-valid and exports the 'tool' object correctly.`);
      }

      return `Success: Tool '${name}' has been successfully written, dynamically loaded, and registered! It is now fully active and available for you to execute.`;
    } catch (error: any) {
      throw new Error(`Failed to create dynamic tool '${name}': ${error.message}`);
    }
  },
};
