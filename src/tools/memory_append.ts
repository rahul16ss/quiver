import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import { Tool } from "../registry.js";
import { getProjectMemoryDir } from "../paths.js";

export const tool: Tool = {
  name: "memory_append",
  description:
    "Appends new facts, user preferences, or self-learning logs to a persistent memory file in the memory directory.",
  parameters: z.object({
    filename: z
      .string()
      .describe(
        "The name of the memory file (e.g., 'human.txt' for user details, 'persona.txt' for behavior notes).",
      ),
    content: z.string().describe("The content or fact to append to the file."),
  }),
  execute: async ({ filename, content }) => {
    const memoryDir = getProjectMemoryDir();
    const cleanFilename = path.basename(filename);
    const targetFile = path.join(memoryDir, cleanFilename);

    // Security: enforce maximum memory file size (1MB)
    const MAX_MEMORY_FILE_SIZE = 1024 * 1024;

    try {
      await fs.mkdir(memoryDir, { recursive: true });

      let exists = true;
      let currentSize = 0;
      try {
        const stats = await fs.stat(targetFile);
        currentSize = stats.size;
      } catch {
        exists = false;
      }

      // Check if appending would exceed the limit
      const appendSize = exists ? content.length + 1 : content.length;
      if (currentSize + appendSize > MAX_MEMORY_FILE_SIZE) {
        return `Error: Memory file '${cleanFilename}' would exceed the 1MB size limit (${currentSize + appendSize} bytes). Use memory_replace to restructure.`;
      }

      const formattedContent = exists ? `\n${content}` : content;
      await fs.appendFile(targetFile, formattedContent, "utf8");

      return `Successfully appended to memory file '${cleanFilename}'.`;
    } catch (error: any) {
      return `Error appending to memory file: ${error.message}`;
    }
  },
};
