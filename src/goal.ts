import { promises as fs } from "fs";
import * as path from "path";
import { spawnSync, execSync } from "child_process";
import picocolors from "picocolors";

export interface Goal {
  id: number;
  task: string;
  status: "pending" | "completed" | "failed";
  verification?: string; // Custom shell command to run to verify the goal
}

const GOALS_FILE = path.resolve("goals.json");

const DEFAULT_GOALS: Goal[] = [
  {
    id: 1,
    task: "Create a new tool src/tools/market_research.ts that utilizes Parallel.ai web search to find competitor information for a target company and save it as JSON.",
    status: "pending",
    verification: "npx tsc --noEmit && npm test"
  },
  {
    id: 2,
    task: "Use the new market_research tool to retrieve pricing and feature details for 'Supabase' and save the results to competitor_supabase.json.",
    status: "pending",
    verification: "test -f competitor_supabase.json"
  },
  {
    id: 3,
    task: "Compile competitor_supabase.json data into a highly structured markdown report comparison table at supabase_market_report.md.",
    status: "pending",
    verification: "test -f supabase_market_report.md"
  }
];

// Initialize goals file if it does not exist
async function ensureGoalsFile(): Promise<Goal[]> {
  try {
    const content = await fs.readFile(GOALS_FILE, "utf8");
    return JSON.parse(content);
  } catch (err) {
    console.log(picocolors.cyan(`📝 Initializing new goals.json template...`));
    await fs.writeFile(GOALS_FILE, JSON.stringify(DEFAULT_GOALS, null, 2), "utf8");
    return DEFAULT_GOALS;
  }
}

async function saveGoals(goals: Goal[]): Promise<void> {
  await fs.writeFile(GOALS_FILE, JSON.stringify(goals, null, 2), "utf8");
}

async function main() {
  console.log(picocolors.cyan(picocolors.bold(`\n================================================`)));
  console.log(picocolors.cyan(picocolors.bold(`🎯 QUIVER GOAL-SEEKING HARNESS 🎯`)));
  console.log(picocolors.cyan(picocolors.bold(`================================================`)));

  const goals = await ensureGoalsFile();

  const nextGoal = goals.find((g) => g.status === "pending");
  if (!nextGoal) {
    console.log(picocolors.green("\n🎉 All goals are completed! No pending tasks remaining."));
    process.exit(0);
  }

  console.log(picocolors.yellow(`\n🚀 Next Goal [ID: ${nextGoal.id}]:`));
  console.log(picocolors.white(`   ${nextGoal.task}`));

  // 1. Execute Quiver in single-turn mode for this specific goal
  console.log(picocolors.gray(`\n📂 Launching Quiver agent session...`));
  const prompt = `Your goal task is: "${nextGoal.task}"\n\nExecute all necessary steps and tools. When done, output a summary.`;
  
  const result = spawnSync("npx", ["tsx", "src/cli.ts", "--single-turn", prompt], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    console.log(picocolors.red(`\n❌ Quiver agent execution failed with exit code ${result.status}.`));
    nextGoal.status = "failed";
    await saveGoals(goals);
    process.exit(1);
  }

  // 2. Run verification script if provided
  if (nextGoal.verification) {
    console.log(picocolors.gray(`\n🔍 Running Verification: `) + picocolors.green(nextGoal.verification));
    try {
      execSync(nextGoal.verification, { stdio: "inherit" });
      console.log(picocolors.green("✅ Verification passed successfully."));
    } catch (err: any) {
      console.log(picocolors.red(`\n❌ Verification failed: ${err.message}`));
      nextGoal.status = "failed";
      await saveGoals(goals);
      process.exit(1);
    }
  }

  // 3. Git commit changes on success
  console.log(picocolors.gray(`\n💾 Committing changes to Git...`));
  try {
    execSync("git add .", { stdio: "inherit" });
    const commitMsg = `quiver-goal: completed goal ID ${nextGoal.id} - ${nextGoal.task.substring(0, 50)}...`;
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
    console.log(picocolors.green("✅ State committed successfully."));
  } catch (err) {
    // If there is nothing to commit, continue
    console.log(picocolors.yellow("ℹ️  No changes to commit."));
  }

  // 4. Update status and loop
  nextGoal.status = "completed";
  await saveGoals(goals);

  console.log(picocolors.green(`\n🎉 Goal ID ${nextGoal.id} completed successfully!`));
  
  // Recursively loop to next pending goal
  // Run this orchestrator process again to boot in fresh memory space
  console.log(picocolors.cyan(`\n🔄 Rebooting loop for next goal...`));
  const loopResult = spawnSync("npx", ["tsx", "src/goal.ts"], {
    stdio: "inherit"
  });
  
  process.exit(loopResult.status ?? 0);
}

main().catch((err) => {
  console.error("Quiver goal runner exception:", err);
  process.exit(1);
});
