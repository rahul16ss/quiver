import { promises as fs } from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { statusLine, theme, renderProgressBar } from "./cli_ui.js";
import { globalRegistry } from "./registry.js";
import { Agent } from "./agent.js";
import { validateConfig, config } from "./config.js";

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
    verification: "npx tsc --noEmit && npm test",
  },
  {
    id: 2,
    task: "Use the new market_research tool to retrieve pricing and feature details for 'Supabase' and save the results to competitor_supabase.json.",
    status: "pending",
    verification: "test -f competitor_supabase.json",
  },
  {
    id: 3,
    task: "Compile competitor_supabase.json data into a highly structured markdown report comparison table at supabase_market_report.md.",
    status: "pending",
    verification: "test -f supabase_market_report.md",
  },
];

// Initialize goals file if it does not exist
async function ensureGoalsFile(): Promise<Goal[]> {
  try {
    const content = await fs.readFile(GOALS_FILE, "utf8");
    return JSON.parse(content);
  } catch (err) {
    statusLine("INFO", "Initializing new goals.json template...");
    await fs.writeFile(
      GOALS_FILE,
      JSON.stringify(DEFAULT_GOALS, null, 2),
      "utf8",
    );
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
      verification: g.verification,
    }));
    await fs.writeFile(GOALS_FILE, JSON.stringify(goals, null, 2), "utf8");
    statusLine(
      "OK",
      `Loaded recipe "${recipeName}" and initialized goals.json.`,
    );
  } catch (err: any) {
    statusLine(
      "ERROR",
      `Failed to load recipe "${recipeName}": ${err.message}`,
    );
    process.exit(1);
  }
}

async function saveGoals(goals: Goal[]): Promise<void> {
  await fs.writeFile(GOALS_FILE, JSON.stringify(goals, null, 2), "utf8");
}

async function main() {
  const t = theme();
  console.log(
    t.cyan(t.bold(`\n================================================`)),
  );
  console.log(t.cyan(t.bold(`🎯 Quiver Task Orchestrator`)));
  console.log(
    t.cyan(t.bold(`================================================`)),
  );

  if (config.dryRun) {
    statusLine(
      "DRY",
      "Dry-run mode — tool actions are previewed, not executed.",
    );
  }

  const recipeIndex = process.argv.indexOf("--recipe");
  if (recipeIndex !== -1 && recipeIndex + 1 < process.argv.length) {
    const recipeName = process.argv[recipeIndex + 1];
    await loadRecipeAndInitGoals(recipeName);
  }

  validateConfig();

  statusLine("INFO", "Loading available AI actions…");
  await globalRegistry.loadAll();
  const tools = globalRegistry.getAllTools();
  statusLine("OK", `Loaded ${tools.length} capabilities`);

  const agent = new Agent(globalRegistry);
  statusLine("INFO", "Continuous AI session started");
  console.log(t.gray(`   Session ID:   ${agent.getSessionId()}`));
  console.log(t.gray(`   Session Logs: ${agent.getSessionLogRelPath()}\n`));

  while (true) {
    const goals = await ensureGoalsFile();
    const pendingGoals = goals.filter((g) => g.status === "pending");
    const completedCount = goals.filter((g) => g.status === "completed").length;
    const nextGoal = pendingGoals[0];

    if (!nextGoal) {
      statusLine(
        "OK",
        "All goals completed — checklist executed successfully.",
      );
      break;
    }

    const progress = renderProgressBar(
      completedCount,
      goals.length,
      `goal ${nextGoal.id}`,
    );
    console.log(t.yellow(`\n${progress}`));
    console.log(t.white(`   ${nextGoal.task}`));
    statusLine("INFO", "Running task inside continuous AI session…");

    // Refresh dynamic tool registry so any code-written tools are imported immediately
    await globalRegistry.loadAll();

    const prompt = `Your goal task is: "${nextGoal.task}"\n\nExecute all necessary steps and tools. When done, output a summary.`;

    process.stdout.write(theme().promptAgent());
    try {
      await agent.prompt(prompt, (token) => {
        process.stdout.write(token);
      });
      console.log("\n");
    } catch (err: any) {
      statusLine("ERROR", `AI session execution failed: ${err.message}`);
      nextGoal.status = "failed";
      await saveGoals(goals);
      process.exit(1);
    }

    // Run verification check if provided
    if (nextGoal.verification) {
      statusLine("INFO", `Verifying: ${nextGoal.verification}`);
      try {
        execSync(nextGoal.verification, { stdio: "inherit" });
        statusLine("OK", "Verification passed");
      } catch (err: any) {
        statusLine("ERROR", `Verification failed: ${err.message}`);
        nextGoal.status = "failed";
        await saveGoals(goals);
        process.exit(1);
      }
    }

    // Update goals status
    nextGoal.status = "completed";
    await saveGoals(goals);

    // Git commit modifications
    statusLine("INFO", "Committing changes to Git…");
    try {
      execSync("git add .", { stdio: "inherit" });
      const commitMsg = `quiver-goal: completed goal ID ${nextGoal.id} - ${nextGoal.task.substring(0, 50)}...`;
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, {
        stdio: "inherit",
      });
      statusLine("OK", "State committed successfully");
    } catch {
      statusLine("WARN", "No changes to commit");
    }

    statusLine("OK", `Task ID ${nextGoal.id} completed successfully`);
  }
}

main().catch((err) => {
  console.error("Quiver goal runner exception:", err);
  process.exit(1);
});
