import { exec } from "child_process";
import { z } from "zod";
import picocolors from "picocolors";
import { Tool } from "../registry.js";
import { classifyCommand, targetsOutsideWorkspace } from "../security/command_policy.js";
import { createSandboxProfile, spawnSandboxed } from "../security/seatbelt.js";

export const tool: Tool = {
  name: "run_command",
  description:
    "Runs a shell command in the terminal and returns stdout, stderr, and exit code. " +
    "Commands are classified into risk bands (US-6.2); destructive, privileged, network, " +
    "secret-risk, and exfiltration commands require user approval before execution.",
  parameters: z.object({
    command: z.string().describe("The exact CLI command to run."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the command. Defaults to current directory."),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds. Default: 30000 (30s). Max: 120000 (2min)."),
  }),
  execute: async ({ command, cwd, timeout }) => {
    const maxBuffer = 1024 * 1024 * 10; // 10MB
    const effectiveTimeout = Math.min(timeout || 30000, 120000);
    const workingDir = cwd || process.cwd();

    // US-6.2: classify the command into a risk band. The agent's approval gate
    // uses this classification to prompt the user before high-risk commands; as
    // defense-in-depth the tool also refuses commands that target paths outside
    // the workspace (escape / exfiltration attempts).
    const classification = classifyCommand(command, workingDir);
    if (targetsOutsideWorkspace(command, workingDir)) {
      return `Error: Refusing to run command '${command}' — it targets a path outside the workspace ('${workingDir}'). Run commands that operate outside the workspace manually.`;
    }

    const riskTag =
      classification.risk === "safe" ? "" : picocolors.gray(` [risk: ${classification.risk}]`);
    console.log(picocolors.gray(`   Running command: ${command}`) + riskTag);

    const seatbeltRiskBands = new Set([
      "destructive",
      "privileged",
      "network",
      "secret-risk",
      "exfiltration-risk",
    ]);
    const useSeatbelt = seatbeltRiskBands.has(classification.risk);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (
        stdout: string,
        stderr: string,
        exitCode: number,
        timedOut: boolean,
        sandboxMethod?: string,
      ) => {
        if (settled) return;
        settled = true;
        const parts: string[] = [];
        if (sandboxMethod) parts.push(`SANDBOX: ${sandboxMethod}`);
        if (stdout) parts.push(`STDOUT:\n${stdout.trim()}`);
        if (stderr) parts.push(`STDERR:\n${stderr.trim()}`);
        parts.push(`EXIT CODE: ${exitCode}`);
        if (timedOut) {
          parts.push(`(Command timed out after ${effectiveTimeout}ms)`);
        }
        resolve(parts.join("\n\n"));
      };

      if (!useSeatbelt) {
        exec(
          command,
          { maxBuffer, cwd: workingDir, timeout: effectiveTimeout },
          (error, stdout, stderr) => {
            finish(
              stdout,
              stderr,
              typeof error?.code === "number" ? error.code : error ? 1 : 0,
              !!error?.killed,
            );
          },
        );
        return;
      }

      // Risky commands run inside macOS Seatbelt. On Windows and when
      // sandbox-exec is unavailable, spawnSandboxed reports the documented
      // path-policy fallback instead of pretending to provide OS isolation.
      const { child, result } = spawnSandboxed(
        command,
        createSandboxProfile(workingDir, {
          allowNetwork: classification.risk === "network",
        }),
        { cwd: workingDir },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, effectiveTimeout);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (stdout.length < maxBuffer) stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        if (stderr.length < maxBuffer) stderr += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        finish(stdout, `${stderr}\n${error.message}`.trim(), 1, timedOut, result.method);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        finish(stdout, stderr, code ?? 1, timedOut, result.method);
      });
    });
  },
};
