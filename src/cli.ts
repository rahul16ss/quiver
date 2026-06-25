import readline from "readline";
import picocolors from "picocolors";
import { config, validateConfig } from "./config.js";
import { globalRegistry } from "./global_registry.js";
import { Agent } from "./agent.js";

// Helper to ask user for terminal input in the loop
function promptUser(rl: readline.Interface, promptText: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(promptText, answer => {
      resolve(answer);
    });
  });
}

async function checkOllamaConnectivity(): Promise<boolean> {
  if (config.llmBaseUrl.includes("localhost") || config.llmBaseUrl.includes("127.0.0.1")) {
    try {
      // Fetch /api/tags or /api/version to check if Ollama daemon is running
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const baseUrl = config.llmBaseUrl.replace(/\/v1\/?$/, ""); // strip /v1 if present for check
      const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeoutId);
      return response.ok;
    } catch (e) {
      return false;
    }
  }
  return true; // Assume non-localhost or external host is reachable
}

async function main() {
  console.log(picocolors.cyan(picocolors.bold(`\n================================================`)));
  console.log(picocolors.cyan(picocolors.bold(`⚡ QUIVER: PERSONAL AGENT HARNESS (TypeScript CLI) ⚡`)));
  console.log(picocolors.cyan(picocolors.bold(`================================================`)));

  // Load and validate config
  validateConfig();

  // Check Ollama daemon status if configured to localhost
  const isOllamaConnected = await checkOllamaConnectivity();
  if (!isOllamaConnected) {
    console.log(picocolors.yellow(`⚠️  Warning: Ollama server appears to be OFFLINE at ${config.llmBaseUrl}.`));
    console.log(picocolors.gray(`   Run 'ollama serve' in another terminal, or update LLM_API_BASE_URL in '.env'.`));
    console.log(picocolors.gray(`   Press Ctrl+C to exit, or proceed if the server is starting up.\n`));
  } else {
    console.log(picocolors.green(`✅ Local model endpoint is accessible.`));
  }

  // Load Registry
  console.log(picocolors.gray("📂 Loading dynamic tool registry..."));
  await globalRegistry.loadAll();
  const tools = globalRegistry.getAllTools();
  console.log(picocolors.green(`✅ Loaded ${tools.length} active tools:`));
  tools.forEach(t => {
    console.log(picocolors.gray(`   ├─ `) + picocolors.green(t.name) + picocolors.gray(`: ${t.description.substring(0, 60)}...`));
  });
  console.log("");

  // Instantiate Agent
  const agent = new Agent(globalRegistry);
  console.log(picocolors.blue(`💬 Session started.`));
  console.log(picocolors.gray(`   Session ID:   ${agent.getSessionId()}`));
  console.log(picocolors.gray(`   Session Logs: .sessions/${agent.getSessionId()}.json`));
  console.log(picocolors.gray(`   Commands:     Type '/exit' to quit, '/tools' to list tools, '/approvals' for security config, '/session' for details.\n`));

  // Argument parsing for single-turn script mode
  const args = process.argv.slice(2);
  const singleTurnIdx = args.indexOf("--single-turn");
  if (singleTurnIdx !== -1) {
    const promptText = args[singleTurnIdx + 1];
    if (!promptText) {
      console.error(picocolors.red("❌ Error: --single-turn requires a prompt string."));
      process.exit(1);
    }
    console.log(picocolors.cyan(`🚀 Running single-turn prompt: "${promptText}"`));
    process.stdout.write(picocolors.bold(picocolors.magenta("\nagent> ")));
    try {
      await agent.prompt(promptText, (token) => {
        process.stdout.write(token);
      });
      console.log("\n");
      process.exit(0);
    } catch (err: any) {
      console.error(picocolors.red(`\n❌ Error: ${err.message}`));
      process.exit(1);
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const promptSymbol = picocolors.bold(picocolors.green("user> "));
      const input = await promptUser(rl, promptSymbol);
      const cleanInput = input.trim();

      if (!cleanInput) continue;

      if (cleanInput === "/exit" || cleanInput === "/quit") {
        console.log(picocolors.yellow("\n👋 Exiting session. Goodbye!"));
        break;
      }

      if (cleanInput === "/tools") {
        console.log(picocolors.cyan(`\n🛠️  Active Registry Tools (${globalRegistry.getAllTools().length}):`));
        globalRegistry.getAllTools().forEach(t => {
          console.log(`   - ${picocolors.green(t.name)}: ${t.description}`);
        });
        console.log("");
        continue;
      }

      if (cleanInput.startsWith("/approvals")) {
        const parts = cleanInput.split(/\s+/);
        const subcommand = parts[1];
        const argsStr = parts.slice(2).join(" ");

        if (!subcommand) {
          console.log(picocolors.cyan(`\n🔒 Security Approvals Config:`));
          console.log(`   - Current List: ${config.requireApprovalFor.length > 0 ? picocolors.green(config.requireApprovalFor.join(", ")) : picocolors.yellow("None")}`);
          console.log(picocolors.gray(`   - Commands:`));
          console.log(picocolors.gray(`     ├─ /approvals set tool1,tool2`));
          console.log(picocolors.gray(`     ├─ /approvals add toolName`));
          console.log(picocolors.gray(`     ├─ /approvals remove toolName`));
          console.log(picocolors.gray(`     └─ /approvals clear\n`));
          continue;
        }

        switch (subcommand.toLowerCase()) {
          case "set": {
            const list = argsStr.split(",").map(s => s.trim()).filter(Boolean);
            config.requireApprovalFor = list;
            console.log(picocolors.green(`✅ Approvals set to: ${list.join(", ") || "None"}\n`));
            break;
          }
          case "add": {
            const toolName = argsStr.trim();
            if (!toolName) {
              console.log(picocolors.red(`❌ Please specify a tool name to add. Example: /approvals add run_command\n`));
            } else if (config.requireApprovalFor.includes(toolName)) {
              console.log(picocolors.yellow(`ℹ️  Tool '${toolName}' is already in the approval list.\n`));
            } else {
              config.requireApprovalFor.push(toolName);
              console.log(picocolors.green(`✅ Tool '${toolName}' added to approvals list. Current list: ${config.requireApprovalFor.join(", ")}\n`));
            }
            break;
          }
          case "remove": {
            const toolName = argsStr.trim();
            if (!toolName) {
              console.log(picocolors.red(`❌ Please specify a tool name to remove. Example: /approvals remove run_command\n`));
            } else {
              const idx = config.requireApprovalFor.indexOf(toolName);
              if (idx === -1) {
                console.log(picocolors.yellow(`ℹ️  Tool '${toolName}' is not in the approval list.\n`));
              } else {
                config.requireApprovalFor.splice(idx, 1);
                console.log(picocolors.green(`✅ Tool '${toolName}' removed from approvals list. Current list: ${config.requireApprovalFor.join(", ") || "None"}\n`));
              }
            }
            break;
          }
          case "clear": {
            config.requireApprovalFor = [];
            console.log(picocolors.green(`✅ All tool approvals cleared. Tool execution is now fully automatic.\n`));
            break;
          }
          default: {
            console.log(picocolors.red(`❌ Unknown approvals command '${subcommand}'. Use set, add, remove, or clear.\n`));
          }
        }
        continue;
      }

      if (cleanInput === "/session") {
        console.log(picocolors.cyan(`\n📊 Session Status:`));
        console.log(`   - Session ID: ${agent.getSessionId()}`);
        console.log(`   - Log File:   .sessions/${agent.getSessionId()}.json`);
        console.log(`   - Messages:   ${agent.getMessages().length} current turns\n`);
        continue;
      }

      // Stream the agent response
      process.stdout.write(picocolors.bold(picocolors.magenta("\nagent> ")));
      
      try {
        await agent.prompt(cleanInput, (token) => {
          process.stdout.write(token);
        });
      } catch (err: any) {
        console.error(picocolors.red(`\n❌ Error in agent loop: ${err.message}`));
      }
      
      console.log("\n"); // line break after model output
    }
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(picocolors.red("Fatal CLI error:"), err);
  process.exit(1);
});
