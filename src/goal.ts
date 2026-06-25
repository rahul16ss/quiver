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

async function loadRecipeAndInitGoals(recipeName: string): Promise<void> {
  const recipePath = path.resolve("recipes", `${recipeName}.json`);
  try {
    const content = await fs.readFile(recipePath, "utf8");
    const recipe = JSON.parse(content);
    if (!recipe.goals || !Array.isArray(recipe.goals)) {
      throw new Error("Invalid recipe format: 'goals' must be an array.");
    }
    const goals: Goal[] = recipe.goals.map((g: any, index: number) => ({
      id: index + 1,
      task: g.task,
      status: "pending",
      verification: g.verification
    }));
    await fs.writeFile(GOALS_FILE, JSON.stringify(goals, null, 2), "utf8");
    console.log(picocolors.green(`\n📑 Loaded recipe "${recipeName}" and initialized goals.json.`));
  } catch (err: any) {
    console.error(picocolors.red(`\n❌ Failed to load recipe "${recipeName}": ${err.message}`));
    process.exit(1);
  }
}

async function saveGoals(goals: Goal[]): Promise<void> {
  await fs.writeFile(GOALS_FILE, JSON.stringify(goals, null, 2), "utf8");
}

async function main() {
  console.log(picocolors.cyan(picocolors.bold(`\n================================================`)));
  console.log(picocolors.cyan(picocolors.bold(`🎯 Quiver Task Orchestrator 🎯`)));
  console.log(picocolors.cyan(picocolors.bold(`================================================`)));

  const recipeIndex = process.argv.indexOf("--recipe");
  if (recipeIndex !== -1 && recipeIndex + 1 < process.argv.length) {
    const recipeName = process.argv[recipeIndex + 1];
    await loadRecipeAndInitGoals(recipeName);
  }

  const goals = await ensureGoalsFile();

  const nextGoal = goals.find((g) => g.status === "pending");
  if (!nextGoal) {
    console.log(picocolors.green("\n🎉 All goals are completed! No pending tasks remaining."));
    process.exit(0);
  }

  console.log(picocolors.yellow(`\n🚀 Next Task [ID: ${nextGoal.id}]:`));
  console.log(picocolors.white(`   ${nextGoal.task}`));

  // 1. Execute Quiver in single-turn mode for this specific goal
  console.log(picocolors.gray(`\n📂 Starting AI session for this task...`));
  const prompt = `Your goal task is: "${nextGoal.task}"\n\nExecute all necessary steps and tools. When done, output a summary.`;
  
  const result = spawnSync("npx", ["tsx", "src/cli.ts", "--single-turn", prompt], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    console.log(picocolors.red(`\n❌ AI session execution failed.`));
    nextGoal.status = "failed";
    await saveGoals(goals);
    process.exit(1);
  }

  // 2. Run verification script if provided
  if (nextGoal.verification) {
    console.log(picocolors.gray(`\n🔍 Verifying completed task: `) + picocolors.green(nextGoal.verification));
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

  // 3. Update status
  nextGoal.status = "completed";
  await saveGoals(goals);

  // 4. Git commit changes on success
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

  console.log(picocolors.green(`\n🎉 Task ID ${nextGoal.id} completed successfully!`));
  
  // Recursively loop to next pending goal
  // Run this orchestrator process again to boot in fresh memory space
  console.log(picocolors.cyan(`\n🔄 Starting next task in checklist...`));
  const loopResult = spawnSync("npx", ["tsx", "src/goal.ts"], {
    stdio: "inherit"
  });
  
  process.exit(loopResult.status ?? 0);
}

main().catch((err) => {
  console.error("Quiver goal runner exception:", err);
  process.exit(1);
});
