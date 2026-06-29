import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";
import { atomicWrite } from "../fs/atomic_write.js";

export const tool: Tool = {
  name: "write_file",
  description: "Creates or overwrites a file with the specified content.",
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path of the file to write."),
    content: z.string().describe("The complete string content to write to the file."),
  }),
  execute: async ({ filePath, content }) => {
    try {
      // US-9.2: sandbox the path before any filesystem access.
      const resolved = assertToolPathAllowed(filePath, "write");
      const resolvedPath = resolved.absolutePath;
      // US-10.2: atomic write (temp → rename) with backup + rollback history.
      await atomicWrite(resolvedPath, content);
      return `File successfully written to ${resolvedPath}`;
    } catch (error: any) {
      throw new Error(`Failed to write file to ${filePath}: ${error.message}`);
    }
  },
};
