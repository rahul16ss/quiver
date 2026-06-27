import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import { Tool } from "../registry.js";
import { getProjectMemoryDir } from "../paths.js";

export const tool: Tool = {
  name: "memory_replace",
  description: "Rewrites or replaces the full content of a persistent memory file in the memory directory (e.g., to restructure notes or update profile variables).",
  parameters: z.object({
    filename: z.string().describe("The name of the memory file to overwrite (e.g., 'human.txt', 'persona.txt')."),
    content: z.string().describe("The new content to write to the memory file."),
  }),
  execute: async ({ filename, content }) => {
    const memoryDir = getProjectMemoryDir();
    const cleanFilename = path.basename(filename);
    const targetFile = path.join(memoryDir, cleanFilename);

    try {
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(targetFile, content, "utf8");
      return `Successfully updated memory file '${cleanFilename}' with new content.`;
    } catch (error: any) {
      return `Error writing to memory file: ${error.message}`;
    }
  },
};
