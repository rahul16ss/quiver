import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import { config } from "../config.js";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "memory_append",
  description: "Appends new facts, user preferences, or self-learning logs to a persistent memory file in the memory directory.",
  parameters: z.object({
    filename: z.string().describe("The name of the memory file (e.g., 'human.txt' for user details, 'persona.txt' for behavior notes)."),
    content: z.string().describe("The content or fact to append to the file."),
  }),
  execute: async ({ filename, content }) => {
    const memoryDir = path.resolve(config.memoryDir);
    const cleanFilename = path.basename(filename);
    const targetFile = path.join(memoryDir, cleanFilename);

    try {
      await fs.mkdir(memoryDir, { recursive: true });
      
      let exists = true;
      try {
        await fs.stat(targetFile);
      } catch (e) {
        exists = false;
      }

      const formattedContent = exists ? `\n${content}` : content;
      await fs.appendFile(targetFile, formattedContent, "utf8");

      return `Successfully appended to memory file '${cleanFilename}'.`;
    } catch (error: any) {
      return `Error appending to memory file: ${error.message}`;
    }
  },
};
