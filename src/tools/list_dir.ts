import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "list_dir",
  description: "Lists the direct children (files and subdirectories) of a directory.",
  parameters: z.object({
    directoryPath: z.string().describe("The absolute or relative path to the directory to list. Defaults to current directory if empty.").default("."),
  }),
  execute: async ({ directoryPath }) => {
    try {
      const resolvedPath = path.resolve(directoryPath || ".");
      const files = await fs.readdir(resolvedPath, { withFileTypes: true });
      
      const items = files.map(file => ({
        name: file.name,
        type: file.isDirectory() ? "directory" : file.isFile() ? "file" : "other",
      }));

      return JSON.stringify(items, null, 2);
    } catch (error: any) {
      throw new Error(`Failed to list directory at ${directoryPath}: ${error.message}`);
    }
  },
};
