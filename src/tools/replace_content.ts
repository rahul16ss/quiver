import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "replace_content",
  description: "Replaces a specific target substring in a file with a new replacement string. Accurate for small, scoped edits.",
  parameters: z.object({
    filePath: z.string().describe("The absolute or relative path to the file to modify."),
    targetContent: z.string().describe("The exact target substring in the file to find and replace."),
    replacementContent: z.string().describe("The new replacement content to substitute."),
  }),
  execute: async ({ filePath, targetContent, replacementContent }) => {
    try {
      const resolvedPath = path.resolve(filePath);
      const content = await fs.readFile(resolvedPath, "utf8");

      if (!content.includes(targetContent)) {
        throw new Error(`Target content to replace was not found in ${filePath}. Check for exact whitespace/line endings.`);
      }

      // Check for multiple occurrences
      const occurrences = content.split(targetContent).length - 1;
      if (occurrences > 1) {
        throw new Error(`Target content appears multiple times (${occurrences}) in the file. Make your targetContent more specific.`);
      }

      const updated = content.replace(targetContent, replacementContent);
      await fs.writeFile(resolvedPath, updated, "utf8");
      return `Successfully replaced target content in ${resolvedPath}.`;
    } catch (error: any) {
      throw new Error(`Failed to replace content in ${filePath}: ${error.message}`);
    }
  },
};
