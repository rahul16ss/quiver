import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "view_file",
  description: "Reads and returns the contents of a file on the local filesystem.",
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path to the file to read."),
  }),
  execute: async ({ filePath }) => {
    try {
      const resolvedPath = path.resolve(filePath);
      const content = await fs.readFile(resolvedPath, "utf8");
      return content;
    } catch (error: any) {
      throw new Error(`Failed to read file at ${filePath}: ${error.message}`);
    }
  },
};
