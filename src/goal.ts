import { promises as fs } from "fs";
import * as path from "path";
import { execSync } from "child_process";
import picocolors from "picocolors";
import { globalRegistry } from "./registry.js";
import { Agent } from "./agent.js";
import { validateConfig } from "./config.js";

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

  // Load and validate config once
  validateConfig();

  // Load Registry once initially
  console.log(picocolors.gray("📂 Loading available AI actions..."));
  await globalRegistry.loadAll();
  const tools = globalRegistry.getAllTools();
  console.log(picocolors.green(`✅ Loaded ${tools.length} capabilities.\n`));

  // Instantiate the single continuous Agent session
  const agent = new Agent(globalRegistry);
  console.log(picocolors.blue(`💬 Continuous AI session started.`));
  console.log(picocolors.gray(`   Session ID:   ${agent.getSessionId()}`));
  console.log(picocolors.gray(`   Session Logs: .sessions/${agent.getSessionId()}.json\n`));

  // Loop through all goals continuously in-process
  while (true) {
    const goals = await ensureGoalsFile();
    const nextGoal = goals.find((g) => g.status === "pending");

    if (!nextGoal) {
      console.log(picocolors.green("\n🎉 All goals are completed! Checklist executed successfully in a single session."));
      break;
    }

    console.log(picocolors.yellow(`\n🚀 Next Task [ID: ${nextGoal.id}]:`));
    console.log(picocolors.white(`   ${nextGoal.task}`));
    console.log(picocolors.gray(`\n📂 Running task inside continuous AI session...`));

    // Refresh dynamic tool registry so any code-written tools are imported immediately
    await globalRegistry.loadAll();

    const prompt = `Your goal task is: "${nextGoal.task}"\n\nExecute all necessary steps and tools. When done, output a summary.`;

    process.stdout.write(picocolors.bold(picocolors.magenta("\nagent> ")));
    try {
      await agent.prompt(prompt, (token) => {
        process.stdout.write(token);
      });
      console.log("\n");
    } catch (err: any) {
      console.log(picocolors.red(`\n❌ AI session execution failed: ${err.message}`));
      nextGoal.status = "failed";
      await saveGoals(goals);
      process.exit(1);
    }

    // Run verification check if provided
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

    // Update goals status
    nextGoal.status = "completed";
    await saveGoals(goals);

    // Git commit modifications
    console.log(picocolors.gray(`\n💾 Committing changes to Git...`));
    try {
      execSync("git add .", { stdio: "inherit" });
      const commitMsg = `quiver-goal: completed goal ID ${nextGoal.id} - ${nextGoal.task.substring(0, 50)}...`;
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
      console.log(picocolors.green("✅ State committed successfully."));
    } catch (err) {
      console.log(picocolors.yellow("ℹ️  No changes to commit."));
    }

    console.log(picocolors.green(`\n🎉 Task ID ${nextGoal.id} completed successfully!`));
  }
}

main().catch((err) => {
  console.error("Quiver goal runner exception:", err);
  process.exit(1);
});

