import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "write_file",
  description: "Creates or overwrites a file with the specified content.",
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path of the file to write."),
    content: z.string().describe("The complete string content to write to the file."),
  }),
  execute: async ({ filePath, content }) => {
    try {
      const resolvedPath = path.resolve(filePath);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, content, "utf8");
      return `File successfully written to ${resolvedPath}`;
    } catch (error: any) {
      throw new Error(`Failed to write file to ${filePath}: ${error.message}`);
    }
  },
};
