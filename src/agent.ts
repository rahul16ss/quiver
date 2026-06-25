import { promises as fs } from "fs";
import * as path from "path";
import picocolors from "picocolors";
import readline from "readline";
import { config } from "./config.js";
import { ToolRegistry } from "./registry.js";
import { loadCoreMemory } from "./letta.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export class SessionLogger {
  private sessionId: string;
  private logPath: string;
  private logs: any[] = [];

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.logPath = path.resolve(".sessions", `${this.sessionId}.json`);
  }

  public async logEvent(type: string, data: any): Promise<void> {
    this.logs.push({
      timestamp: new Date().toISOString(),
      type,
      data,
    });
    try {
      await fs.mkdir(path.dirname(this.logPath), { recursive: true });
      await fs.writeFile(this.logPath, JSON.stringify(this.logs, null, 2), "utf8");
    } catch (err) {
      // Fail silently for logger writes
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }
}

// Approval gate prompt using terminal readline
async function askUserApproval(toolName: string, args: any): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log(picocolors.yellow(`\n┌── ⚠️  [APPROVAL GATE] ${"─".repeat(25)}`));
    console.log(picocolors.yellow(`│  Tool: `) + picocolors.green(toolName));
    console.log(picocolors.yellow(`│  Args: `) + picocolors.white(JSON.stringify(args, null, 2).replace(/\n/g, "\n│           ")));
    console.log(picocolors.yellow(`└──────────────────────────────────────────────`));
    
    rl.question(picocolors.bold(picocolors.cyan("Approve execution? (y/N): ")), (answer) => {
      rl.close();
      const cleanAnswer = answer.trim().toLowerCase();
      resolve(cleanAnswer === "y" || cleanAnswer === "yes");
    });
  });
}

export class Agent {
  private registry: ToolRegistry;
  private messages: Message[] = [];
  private logger: SessionLogger;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
    this.logger = new SessionLogger();
    
    // Add default system prompt structure (will be dynamically updated with skills and memory)
    this.messages.push({
      role: "system",
      content: "You are a highly capable personal AI coding and research assistant running in the quiver CLI.",
    });
  }

  public getMessages(): Message[] {
    return this.messages;
  }

  public addMessage(message: Message): void {
    this.messages.push(message);
  }

  public getSessionId(): string {
    return this.logger.getSessionId();
  }

  // Load persistent memory files
  private async loadMemory(): Promise<{ filename: string; sizeBytes: number; content: string }[]> {
    const memoryDir = path.resolve(config.memoryDir);
    const results: { filename: string; sizeBytes: number; content: string }[] = [];
    
    try {
      await fs.mkdir(memoryDir, { recursive: true });
      const files = await fs.readdir(memoryDir);
      
      for (const file of files) {
        const filePath = path.join(memoryDir, file);
        const stats = await fs.stat(filePath);
        if (stats.isFile() && !file.startsWith(".")) {
          const content = await fs.readFile(filePath, "utf8");
          results.push({
            filename: file,
            sizeBytes: stats.size,
            content,
          });
        }
      }
    } catch (e) {
      // Ignore directory read errors
    }
    return results;
  }

  // Load versioned skills
  private async loadSkills(): Promise<{ id: string; version: string; purpose: string; content: string }[]> {
    const skillsDir = path.resolve(config.skillsDir);
    const results: { id: string; version: string; purpose: string; content: string }[] = [];

    try {
      await fs.mkdir(skillsDir, { recursive: true });
      const dirs = await fs.readdir(skillsDir);
      
      for (const dir of dirs) {
        if (dir.startsWith(".")) continue;
        const skillPath = path.join(skillsDir, dir, "SKILL.md");
        try {
          const stats = await fs.stat(skillPath);
          if (stats.isFile()) {
            const content = await fs.readFile(skillPath, "utf8");
            
            // Parse YAML-like frontmatter fields
            const nameMatch = content.match(/name:\s*([^\n]+)/i);
            const verMatch = content.match(/version:\s*([^\n]+)/i);
            const purposeMatch = content.match(/purpose:\s*([^\n]+)/i);
            const descMatch = content.match(/description:\s*([^\n]+)/i);
            const licenseMatch = content.match(/license:\s*([^\n]+)/i);
            const compatMatch = content.match(/compatibility:\s*([^\n]+)/i);
            
            const name = nameMatch ? nameMatch[1].trim() : dir;
            const version = verMatch ? verMatch[1].trim() : "1.0.0";
            const purpose = purposeMatch ? purposeMatch[1].trim() : (descMatch ? descMatch[1].trim() : "Custom task procedure");
            const license = licenseMatch ? licenseMatch[1].trim() : "Unknown";
            const compatibility = compatMatch ? compatMatch[1].trim() : "Universal";

            results.push({
              id: name,
              version,
              purpose: `${purpose} [License: ${license}, Compatibility: ${compatibility}]`,
              content,
            });
          }
        } catch (err) {
          // No SKILL.md found in this directory
        }
      }
    } catch (e) {
      // Ignore skills loader errors
    }
    return results;
  }

  /**
   * Run a single prompt turn. This function handles the LLM response,
   * streams text content, handles tool calls, executes them, feeds them back,
   * and repeats until the model finishes calling tools.
   */
  public async prompt(userInput: string, onToken: (token: string) => void): Promise<void> {
    // 1. Dynamically load Skills and Memory Context
    const memories = await this.loadMemory();
    const skills = await this.loadSkills();
    const coreMemory = await loadCoreMemory();

    // 2. Build the rich dynamic system instructions
    let systemPrompt = `You are a highly capable personal AI coding and research assistant.
You are running in a terminal-based CLI harness called "quiver".
You have direct access to system files, browser automation tools, and shell command execution.
You are self-evolving: if you need a new capability, you can write a new TypeScript tool to your local tools directory using the 'create_tool' tool.
Be concise, clear, and direct. When you use tools, run them logically to solve the task at hand.`;

    // Letta Core Memory blocks integration
    systemPrompt += `\n\n--- CORE MEMORY BLOCKS ---
[Identity]: ${coreMemory.identity}
[Human Context]: ${coreMemory.human_context}
[Project Context]: ${coreMemory.project_context}\n`;

    if (memories.length > 0) {
      systemPrompt += `\n--- ACTIVE PERSISTENT MEMORY ---\n`;
      for (const m of memories) {
        systemPrompt += `[Memory Snippet: ${m.filename}]\n${m.content}\n\n`;
      }
    }

    if (skills.length > 0) {
      systemPrompt += `\n--- ACTIVE TASK PROCEDURES (SKILLS) ---\n`;
      for (const s of skills) {
        systemPrompt += `[Skill: ${s.id} (v${s.version})]\nPurpose: ${s.purpose}\nInstructions:\n${s.content}\n\n`;
      }
    }

    // Set or update the system prompt
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = systemPrompt;
    } else {
      this.messages.unshift({ role: "system", content: systemPrompt });
    }

    // Append the user message
    this.messages.push({ role: "user", content: userInput });
    await this.logger.logEvent("user_input", { content: userInput });

    let loopCount = 0;
    const maxLoops = 10;

    while (loopCount < maxLoops) {
      loopCount++;
      await this.logger.logEvent("turn_start", { loop: loopCount, historySize: this.messages.length });

      // Gather current tool definitions
      const activeTools = this.registry.getAllTools();
      const tools = activeTools.map(ToolRegistry.getOpenAIToolDefinition);

      // 3. Compile and display the Context Manifest
      const manifest = {
        sessionId: this.getSessionId(),
        loop: loopCount,
        model: config.llmModelName,
        skills: skills.map(s => ({ id: s.id, version: s.version })),
        memory: memories.map(m => ({ filename: m.filename, sizeBytes: m.sizeBytes })),
        tools: activeTools.map(t => t.name),
        timestamp: new Date().toISOString(),
      };

      // Write context manifest file locally
      const manifestPath = path.resolve(".sessions", `manifest_${this.getSessionId()}_${loopCount}.json`);
      try {
        await fs.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      } catch (err) {}

      // Log context manifest event
      await this.logger.logEvent("context_manifest", manifest);

      // Show Context Manifest summary to user
      console.log(picocolors.cyan(`\n╭──────────────────────────────────────────────╮`));
      console.log(picocolors.cyan(`│             📋 CONTEXT MANIFEST              │`));
      console.log(picocolors.cyan(`├──────────────────────────────────────────────┤`));
      console.log(picocolors.cyan(`│ `) + picocolors.gray(`Model:   `) + picocolors.green(manifest.model));
      console.log(picocolors.cyan(`│ `) + picocolors.gray(`Skills:  `) + (skills.length > 0 ? picocolors.white(skills.map(s => `${s.id} (v${s.version})`).join(", ")) : picocolors.yellow("None")));
      console.log(picocolors.cyan(`│ `) + picocolors.gray(`Memory:  `) + (memories.length > 0 ? picocolors.white(`${memories.length} files (${memories.reduce((acc, m) => acc + m.sizeBytes, 0)} B)`) : picocolors.yellow("None")));
      console.log(picocolors.cyan(`│ `) + picocolors.gray(`Tools:   `) + picocolors.green(`${activeTools.length} active tools`));
      console.log(picocolors.cyan(`╰──────────────────────────────────────────────╯`));

      const payload: any = {
        model: config.llmModelName,
        messages: this.messages,
        temperature: 0.2,
      };

      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (config.llmApiKey) {
        headers["Authorization"] = `Bearer ${config.llmApiKey}`;
      }

      payload.stream = true;

      let response: Response;
      try {
        response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      } catch (err: any) {
        console.error(picocolors.red(`\n❌ Failed to connect to LLM server: ${err.message}`));
        await this.logger.logEvent("api_error", { error: err.message });
        return;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(picocolors.red(`\n❌ LLM Server returned error (${response.status}): ${errorText}`));
        await this.logger.logEvent("api_error", { status: response.status, response: errorText });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        console.error(picocolors.red("\n❌ Response body is not readable."));
        return;
      }

      let assistantContent = "";
      let accumulatedToolCalls: Record<number, { id?: string; name?: string; arguments: string }> = {};
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const cleanLine = line.trim();
          if (!cleanLine || !cleanLine.startsWith("data: ")) continue;
          if (cleanLine === "data: [DONE]") break;

          try {
            const parsed = JSON.parse(cleanLine.substring(6));
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            if (delta.content) {
              assistantContent += delta.content;
              onToken(delta.content);
            }

            if (delta.tool_calls) {
              for (const tcDelta of delta.tool_calls) {
                const index = tcDelta.index;
                if (index === undefined) continue;

                if (!accumulatedToolCalls[index]) {
                  accumulatedToolCalls[index] = { arguments: "" };
                }

                if (tcDelta.id) {
                  accumulatedToolCalls[index].id = tcDelta.id;
                }
                if (tcDelta.function?.name) {
                  accumulatedToolCalls[index].name = tcDelta.function.name;
                }
                if (tcDelta.function?.arguments) {
                  accumulatedToolCalls[index].arguments += tcDelta.function.arguments;
                }
              }
            }
          } catch (e) {
            // Ignore incomplete line parse failures
          }
        }
      }

      const toolCalls: ToolCall[] = Object.keys(accumulatedToolCalls).map(key => {
        const idx = parseInt(key, 10);
        const raw = accumulatedToolCalls[idx];
        return {
          id: raw.id || `call_${Date.now()}_${idx}`,
          type: "function",
          function: {
            name: raw.name || "",
            arguments: raw.arguments || "{}",
          },
        };
      });

      const assistantMsg: Message = {
        role: "assistant",
        content: assistantContent || null,
      };

      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }

      this.messages.push(assistantMsg);
      await this.logger.logEvent("assistant_response", assistantMsg);

      if (toolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      console.log(picocolors.cyan(`\n╭─── 🛠️  Executing ${toolCalls.length} tool call(s) `) + picocolors.cyan("─".repeat(20)));
      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i];
        const toolName = call.function.name;
        let args: any = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch (e) {
          console.error(picocolors.yellow(`│  ⚠️  Failed to parse arguments for tool ${toolName}`));
        }

        // 4. Human-Approval Gate Check
        let isApproved = true;
        if (config.requireApprovalFor.includes(toolName)) {
          isApproved = await askUserApproval(toolName, args);
        }

        let result: any;
        if (!isApproved) {
          result = `Error: Action for tool '${toolName}' was denied/rejected by the user.`;
          console.log(picocolors.red(`│  🚫 Rejected: ${toolName} execution blocked by user.`));
        } else {
          console.log(picocolors.cyan(`│  🚀 Calling: `) + picocolors.green(toolName));
          console.log(picocolors.gray(`│  👉 Args:    ${JSON.stringify(args, null, 2).replace(/\n/g, "\n│              ")}`));
          const tool = this.registry.getTool(toolName);
          if (!tool) {
            result = `Error: Tool '${toolName}' not found in registry.`;
            console.error(picocolors.red(`│  ❌ Error: ${result}`));
          } else {
            try {
              result = await tool.execute(args);
              const displayResult = typeof result === "string" ? result : JSON.stringify(result);
              const preview = displayResult.length > 300 ? `${displayResult.substring(0, 300)}... (truncated)` : displayResult;
              console.log(picocolors.cyan(`│  ✅ Output:  `) + picocolors.magenta(preview.replace(/\n/g, "\n│              ")));
            } catch (error: any) {
              result = `Error executing tool: ${error.message}`;
              console.error(picocolors.red(`│  ❌ Failed:  ${error.message}`));
            }
          }
        }

        if (i < toolCalls.length - 1) {
          console.log(picocolors.cyan(`├${"─".repeat(46)}`));
        }

        const toolMsg: Message = {
          role: "tool",
          content: typeof result === "string" ? result : JSON.stringify(result),
          name: toolName,
          tool_call_id: call.id,
        };

        this.messages.push(toolMsg);
        await this.logger.logEvent("tool_result", { tool: toolName, callId: call.id, result });
      }
      console.log(picocolors.cyan(`╰──────────────────────────────────────────────╯`));

      console.log(picocolors.cyan(`\n📥 Feeding tool results back to LLM...`));
    }

    if (loopCount >= maxLoops) {
      console.warn(picocolors.yellow(`⚠️  Reached max loop iterations (${maxLoops}) to prevent runaways.`));
    }
  }
}
