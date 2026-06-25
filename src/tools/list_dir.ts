import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "list_dir",
  description:
    "Lists the direct children (files and subdirectories) of a directory, " +
    "including file sizes and types. Useful for understanding project structure.",
  parameters: z.object({
    directoryPath: z
      .string()
      .describe(
        "The absolute or relative path to the directory to list. Defaults to current directory if empty.",
      )
      .default("."),
  }),
  execute: async ({ directoryPath }) => {
    try {
      const resolvedPath = path.resolve(directoryPath || ".");
      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

      // Sort: directories first, then files, alphabetically
      const sorted = entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      const items = await Promise.all(
        sorted.map(async (entry) => {
          const fullPath = path.join(resolvedPath, entry.name);
          const type = entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : "other";
          let size: number | undefined;
          if (entry.isFile()) {
            try {
              const stats = await fs.stat(fullPath);
              size = stats.size;
            } catch {
              size = undefined;
            }
          }
          return {
            name: entry.name,
            type,
            size,
          };
        }),
      );

      return JSON.stringify(items, null, 2);
    } catch (error: any) {
      throw new Error(
        `Failed to list directory at ${directoryPath}: ${error.message}`,
      );
    }
  },
};
