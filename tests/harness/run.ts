/**
 * Harness test aggregator — invoked by tests/run_tests.ts after the spec gate.
 *
 * Runs every Phase-N harness test file and reports a single failure count.
 * Live contract tests (tests/harness/live/*) are opt-in via
 * QUIVER_LIVE_CONTRACT=1 and skipped by default so CI never depends on
 * network credentials.
 */
import picocolors from "picocolors";
import { spawn } from "child_process";

export async function runHarnessTests(): Promise<number> {
  console.log(picocolors.cyan("\n🧪 Quiver — Harness Gate (refactor)"));
  console.log("==================================================");

  // Each harness test file is a self-contained script that exits non-zero on
  // failure, so we run them as child processes to isolate failures and capture
  // exit codes.
  const files = ["01-interfaces.test.ts", "02-model-client.test.ts", "03-research-gateway.test.ts", "04-goal-contract.test.ts", "05-execution-engine.test.ts"];

  let totalFailures = 0;
  for (const file of files) {
    const code = await runChild(file);
    if (code !== 0) totalFailures += 1;
  }
  return totalFailures;
}

function runChild(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["tsx", `tests/harness/${file}`],
      { stdio: "inherit", env: process.env },
    );
    child.on("exit", (code: number | null) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}