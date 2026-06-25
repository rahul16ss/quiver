import { exec } from "child_process";
import { z } from "zod";
import picocolors from "picocolors";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "run_command",
  description:
    "Runs a shell command in the terminal and returns stdout, stderr, and exit code. " +
    "Note: Commands in the approval list will prompt for user confirmation before execution.",
  parameters: z.object({
    command: z.string().describe("The exact CLI command to run."),
    cwd: z
      .string()
      .optional()
      .describe(
        "Working directory for the command. Defaults to current directory.",
      ),
    timeout: z
      .number()
      .optional()
      .describe(
        "Timeout in milliseconds. Default: 30000 (30s). Max: 120000 (2min).",
      ),
  }),
  execute: async ({ command, cwd, timeout }) => {
    const maxBuffer = 1024 * 1024 * 10; // 10MB
    const effectiveTimeout = Math.min(timeout || 30000, 120000);

    console.log(picocolors.gray(`   ⚡ Running command: ${command}`));

    return new Promise((resolve) => {
      exec(
        command,
        { maxBuffer, cwd: cwd || undefined, timeout: effectiveTimeout },
        (error, stdout, stderr) => {
          const parts: string[] = [];
          if (stdout) parts.push(`STDOUT:\n${stdout.trim()}`);
          if (stderr) parts.push(`STDERR:\n${stderr.trim()}`);
          if (error) {
            parts.push(`EXIT CODE: ${error.code || 1}`);
            if (error.killed)
              parts.push(`(Command timed out after ${effectiveTimeout}ms)`);
          } else {
            parts.push(`EXIT CODE: 0`);
          }
          resolve(parts.join("\n\n"));
        },
      );
    });
  },
};
