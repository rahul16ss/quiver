import "dotenv/config";

export interface Config {
  llmBaseUrl: string;
  llmModelName: string;
  llmApiKey: string;
  parallelApiKey: string;
  skillsDir: string;
  memoryDir: string;
  browserHeadless: boolean;
  requireApprovalFor: string[];
  context7ApiKey: string;
  githubToken: string;
}

export const config: Config = {
  llmBaseUrl: process.env.LLM_API_BASE_URL || "https://ollama.com/v1",
  llmModelName: process.env.LLM_MODEL_NAME || "glm-5.2:cloud",
  llmApiKey: process.env.LLM_API_KEY || "",
  parallelApiKey: process.env.PARALLEL_API_KEY || "",
  skillsDir: process.env.QUIVER_SKILLS_DIR || "./skills",
  memoryDir: process.env.QUIVER_MEMORY_DIR || "./memory",
  browserHeadless: process.env.BROWSER_HEADLESS !== "false",
  requireApprovalFor: (process.env.REQUIRE_APPROVAL_FOR || "run_command,write_file,replace_content,browser_control,create_tool")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),
  context7ApiKey: process.env.CONTEXT7_API_KEY || "",
  githubToken: process.env.GITHUB_TOKEN || "",
};

export function validateConfig(): void {
  console.log(`\n⚙️  Quiver Config Loaded:`);
  console.log(`   - Endpoint Base:    ${config.llmBaseUrl}`);
  console.log(`   - Target Model:     ${config.llmModelName}`);
  console.log(`   - API Key Set:      ${config.llmApiKey ? "Yes (length: " + config.llmApiKey.length + ")" : "No"}`);
  console.log(`   - Parallel Key:     ${config.parallelApiKey ? "Yes" : "No"}`);
  console.log(`   - Skills Dir:       ${config.skillsDir}`);
  console.log(`   - Memory Dir:       ${config.memoryDir}`);
  console.log(`   - Browser Headless: ${config.browserHeadless}`);
  console.log(`   - Approvals For:    ${config.requireApprovalFor.join(", ") || "None"}`);
  console.log(`   - Context7 Key:     ${config.context7ApiKey ? "Yes" : "No"}`);
  console.log(`   - GitHub Token:     ${config.githubToken ? "Yes" : "No"}\n`);
}
