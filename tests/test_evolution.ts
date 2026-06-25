import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import picocolors from "picocolors";
import { globalRegistry } from "../src/global_registry.js";
import { Agent } from "../src/agent.js";

async function runEvolutionTest() {
  console.log(picocolors.cyan("\n🧬 Running Self-Evolution Integration Test..."));
  
  // 1. Load the dynamic registry
  await globalRegistry.loadAll();
  console.log(`   Registry loaded with ${globalRegistry.getAllTools().length} tools.`);

  // 2. Setup Agent
  const agent = new Agent(globalRegistry);

  // 3. Prompt the agent to evolve a tool and use it
  const prompt = 
    "Create a new tool named 'hash_md5' that computes the MD5 hash of a input string parameter 'text' " +
    "using Node's built-in 'crypto' module. After creating it, execute the 'hash_md5' tool on the string 'antigravity'.";

  console.log(picocolors.yellow(`\n💬 Prompting Agent:\n   "${prompt}"`));
  console.log(picocolors.magenta("\n--- Agent Stream Start ---"));

  try {
    await agent.prompt(prompt, (token) => {
      process.stdout.write(token);
    });
    console.log(picocolors.magenta("\n--- Agent Stream End ---\n"));

    // 4. Verify the tool file was created and is active
    const toolsDir = path.dirname(fileURLToPath(import.meta.url)).replace("/tests", "/src/tools");
    const newToolPath = path.join(toolsDir, "hash_md5.ts");
    
    const fileExists = await fs.stat(newToolPath).then(() => true).catch(() => false);
    if (fileExists) {
      console.log(picocolors.green(`✔ Success: New tool file created at ${newToolPath}`));
      
      // Execute the newly registered tool directly to verify
      const hashTool = globalRegistry.getTool("hash_md5");
      if (hashTool) {
        console.log(picocolors.green("✔ Success: Tool is registered in the live registry."));
        const hashResult = await hashTool.execute({ text: "antigravity" });
        console.log(`   MD5('antigravity') = ${picocolors.bold(picocolors.magenta(hashResult))}`);
        
        // Clean up the created tool file so it doesn't pollute the repository
        await fs.unlink(newToolPath);
        console.log(picocolors.gray("🧹 Cleaned up temporary 'hash_md5.ts' tool file."));
      } else {
        console.error(picocolors.red("❌ Error: Tool 'hash_md5' not found in registry."));
      }
    } else {
      console.error(picocolors.red("❌ Error: New tool file was not created."));
    }
  } catch (error: any) {
    console.error(picocolors.red(`❌ Error running evolution test: ${error.message}`));
  }
}

runEvolutionTest();
