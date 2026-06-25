import { exec } from "child_process";
import readline from "readline";
import { z } from "zod";
import picocolors from "picocolors";
import { Tool } from "../registry.js";

function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const clean = answer.trim().toLowerCase();
      resolve(clean === "y" || clean === "yes");
    });
  });
}

export const tool: Tool = {
  name: "run_command",
  description: "Runs a shell command in the terminal. Executing commands requires user manual confirmation.",
  parameters: z.object({
    command: z.string().describe("The exact CLI command to run."),
  }),
  execute: async ({ command }) => {
    // Check if auto-approve is active
    const autoApprove = process.env.AUTO_APPROVE_COMMANDS === "true";
    
    if (!autoApprove) {
      const promptText = picocolors.bold(
        picocolors.yellow(`\n⚠️  The agent requests to execute shell command:\n` +
          `   > ${picocolors.cyan(command)}\n` +
          `Approve command execution? (y/N): `)
      );
      
      const approved = await askConfirmation(promptText);
      if (!approved) {
        throw new Error("Command execution was rejected by the user.");
      }
    }

    console.log(picocolors.gray(`   ⚡ Running command: ${command}`));

    return new Promise((resolve, reject) => {
      exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        const output = [
          stdout ? `STDOUT:\n${stdout}` : "",
          stderr ? `STDERR:\n${stderr}` : "",
          error ? `EXIT CODE: ${error.code || 1}\nERROR: ${error.message}` : "EXIT CODE: 0"
        ].filter(Boolean).join("\n\n");

        if (error) {
          // Resolve with error info so LLM receives details of the failure
          resolve(output);
        } else {
          resolve(output);
        }
      });
    });
  },
};
