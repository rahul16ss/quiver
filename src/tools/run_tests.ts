import { exec } from "child_process";
import { z } from "zod";
import picocolors from "picocolors";
import { Tool } from "../registry.js";

function executeCmd(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      resolve({
        code: error?.code ?? 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

export const tool: Tool = {
  name: "run_tests",
  description: "Runs TypeScript compilation check (tsc --noEmit) and the unit tests suite to validate codebase integrity. Returns test outcomes and errors.",
  parameters: z.object({}),
  execute: async () => {
    console.log(picocolors.gray(`   Validating codebase (run_tests)...`));

    // 1. Run tsc --noEmit
    console.log(picocolors.gray(`   ├─ Running TypeScript compilation check...`));
    const tscRes = await executeCmd("npx tsc --noEmit");
    if (tscRes.code !== 0) {
      console.log(picocolors.red(`   └─ Compilation failed.`));
      return JSON.stringify({
        success: false,
        phase: "compilation",
        error: "TypeScript compilation failed.",
        stdout: tscRes.stdout,
        stderr: tscRes.stderr,
      }, null, 2);
    }

    // 2. Run npm test
    console.log(picocolors.gray(`   └─ Running unit tests suite...`));
    const testRes = await executeCmd("npm test");
    if (testRes.code !== 0) {
      console.log(picocolors.red(`      Tests failed.`));
      return JSON.stringify({
        success: false,
        phase: "test",
        error: "Unit tests failed.",
        stdout: testRes.stdout,
        stderr: testRes.stderr,
      }, null, 2);
    }

    console.log(picocolors.green(`      Codebase is clean and all tests passed.`));
    return JSON.stringify({
      success: true,
      phase: "all",
      stdout: testRes.stdout,
    }, null, 2);
  },
};
