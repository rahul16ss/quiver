import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import picocolors from "picocolors";
import { ToolRegistry, Tool } from "../src/registry.js";

async function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(picocolors.green(`   ✔ ${message}`));
}

async function runTests() {
  console.log(picocolors.cyan("\n🧪 Running Quiver Registry Tests"));
  console.log("==================================================");

  const testToolsDir = path.resolve("tests", "test_tools");
  
  // Clean start
  await fs.rm(testToolsDir, { recursive: true, force: true });
  await fs.mkdir(testToolsDir, { recursive: true });

  const registry = new ToolRegistry(testToolsDir);

  // 1. Initial registry state
  console.log("\n1. Testing Initial State...");
  await registry.loadAll();
  await assert(registry.getAllTools().length === 0, "Registry should be empty on startup");

  // 2. Creating a dynamic tool at runtime
  console.log("\n2. Testing Dynamic Tool Creation...");
  const firstToolCode = `
import { z } from 'zod';
import { Tool } from '../../src/registry.js';

export const tool: Tool = {
  name: 'add_numbers',
  description: 'Adds two numbers.',
  parameters: z.object({
    a: z.number().describe('First number'),
    b: z.number().describe('Second number')
  }),
  execute: ({ a, b }) => {
    return a + b;
  }
};
`;

  const toolFilePath = path.join(testToolsDir, "add_numbers.ts");
  await fs.writeFile(toolFilePath, firstToolCode, "utf8");

  // Load the newly created tool
  const loadedTool = await registry.loadToolFile(toolFilePath);
  await assert(!!loadedTool, "Dynamic tool should successfully import");
  
  const fetched = registry.getTool("add_numbers");
  await assert(!!fetched, "Tool should be accessible in registry by name");
  await assert(fetched?.name === "add_numbers", "Tool name matches");
  
  // Run execution
  const res = await fetched?.execute({ a: 15, b: 25 });
  await assert(res === 40, `Execution output should be 40 (got: ${res})`);

  // Verify OpenAI structure compilation
  const definition = ToolRegistry.getOpenAIToolDefinition(fetched as Tool);
  await assert(definition.function.name === "add_numbers", "OpenAI tool definition name matches");
  await assert(definition.function.parameters.type === "object", "Zod serialized parameters target object schema");
  await assert(definition.function.parameters.properties.a.type === "number", "Zod serialized param property type matches");

  // 3. Testing Dynamic Reload & Cache Busting (Evolution)
  console.log("\n3. Testing Runtime Tool Reloading (Self-Evolution)...");
  
  const evolvedToolCode = `
import { z } from 'zod';
import { Tool } from '../../src/registry.js';

export const tool: Tool = {
  name: 'add_numbers',
  description: 'Adds two numbers and multiplies by 10 (evolved).',
  parameters: z.object({
    a: z.number(),
    b: z.number()
  }),
  execute: ({ a, b }) => {
    return (a + b) * 10;
  }
};
`;

  // Overwrite the tool file with updated behavior
  await fs.writeFile(toolFilePath, evolvedToolCode, "utf8");
  
  // Reload the tool - this tests the cache busting query parameter
  const reloaded = await registry.loadToolFile(toolFilePath);
  await assert(!!reloaded, "Dynamic tool should successfully re-import");

  const fetchedEvolved = registry.getTool("add_numbers");
  const evolvedRes = await fetchedEvolved?.execute({ a: 15, b: 25 });
  
  await assert(evolvedRes === 400, `Evolved execution output should be 400 (got: ${evolvedRes})`);
  console.log(picocolors.green("   ✔ ESM cache-busting successfully loaded evolved code."));

  // Clean up
  await fs.rm(testToolsDir, { recursive: true, force: true });
  console.log(picocolors.cyan("\n🎉 All tests passed successfully!\n"));
}

runTests().catch(err => {
  console.error(picocolors.red("\n❌ Test execution failed:"), err);
  process.exit(1);
});
