import {
  createCliRenderer,
  BoxRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  TextRenderable,
} from "@opentui/core";
import { globalRegistry } from "./registry.js";
import { Agent } from "./agent.js";
import { loadCoreMemory } from "./state.js";
import { config } from "./config.js";
import { promises as fs } from "fs";
import * as path from "path";
import { resolveTerminalPalette } from "./design_tokens.js";

// Main dashboard handler
async function run() {
  const palette = resolveTerminalPalette();

  // Load dynamic registries
  await globalRegistry.loadAll();
  const agent = new Agent(globalRegistry);

  // Initialize the OpenTUI CLI renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
  });

  // Top level container to structure the full terminal screen
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: palette.background,
  });
  renderer.root.add(container);

  // 1. Header Area
  const header = new BoxRenderable(renderer, {
    width: "100%",
    height: 3,
    border: true,
    borderStyle: "single",
    borderColor: palette.border,
    title: "⚡ QUIVER AGENT HARNESS ⚡",
    titleAlignment: "center",
  });

  const headerText = new TextRenderable(renderer, {
    width: "100%",
    height: 1,
    content: `Session: ${agent.getSessionId()} | Model: ${config.llmModelName} | Connected: YES`,
    fg: "#94a3b8",
  });
  header.add(headerText);
  container.add(header);

  // 2. Middle Columns (Sidebar + Response history)
  const middle = new BoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  });
  container.add(middle);

  // Sidebar (Manifest column)
  const sidebar = new BoxRenderable(renderer, {
    width: "25%",
    height: "100%",
    flexDirection: "column",
    border: true,
    borderStyle: "single",
    borderColor: palette.border,
    title: "CONTEXT MANIFEST",
  });
  middle.add(sidebar);

  // Skills Panel
  const skillsPanel = new BoxRenderable(renderer, {
    width: "100%",
    height: "33%",
    border: true,
    borderStyle: "single",
    borderColor: palette.border,
    title: "LOADED SKILLS",
  });
  const skillsText = new TextRenderable(renderer, {
    width: "100%",
    height: "100%",
    wrapMode: "word",
    fg: palette.textSecondary,
    content: "Loading skills...",
  });
  skillsPanel.add(skillsText);
  sidebar.add(skillsPanel);

  // Memory Panel
  const memoryPanel = new BoxRenderable(renderer, {
    width: "100%",
    height: "33%",
    border: true,
    borderStyle: "single",
    borderColor: palette.border,
    title: "CORE MEMORY",
  });
  const memoryText = new TextRenderable(renderer, {
    width: "100%",
    height: "100%",
    wrapMode: "word",
    fg: palette.textSecondary,
    content: "Loading core memory...",
  });
  memoryPanel.add(memoryText);
  sidebar.add(memoryPanel);

  // Active Tools Panel
  const toolsPanel = new BoxRenderable(renderer, {
    width: "100%",
    height: "34%",
    border: true,
    borderStyle: "single",
    borderColor: palette.border,
    title: "ACTIVE TOOLS",
  });
  const toolsText = new TextRenderable(renderer, {
    width: "100%",
    height: "100%",
    wrapMode: "word",
    fg: palette.textSecondary,
    content: "Loading registry...",
  });
  toolsPanel.add(toolsText);
  sidebar.add(toolsPanel);

  // Main scrollbox log view
  const responseLog = new ScrollBoxRenderable(renderer, {
    width: "75%",
    height: "100%",
    border: true,
    borderStyle: "single",
    borderColor: palette.border,
    title: "AGENT RESPONSE HISTORY & TOOL LOGS",
    stickyScroll: true,
    scrollY: true,
    contentOptions: {
      flexDirection: "column",
    },
  });
  middle.add(responseLog);

  // 3. Footer (Input Box)
  const footer = new BoxRenderable(renderer, {
    width: "100%",
    height: 3,
    border: true,
    borderStyle: "single",
    borderColor: palette.border,
    title: "PROMPT INPUT",
  });

  const promptInput = new InputRenderable(renderer, {
    width: "100%",
    placeholder: "Type message and press Enter (or /exit to quit)...",
  });
  footer.add(promptInput);
  container.add(footer);

  // Function to add structured logs/messages to the history box
  function appendLogMessage(
    text: string,
    fgColor: string = palette.textPrimary,
  ) {
    const logItem = new TextRenderable(renderer, {
      width: "100%",
      wrapMode: "word",
      fg: fgColor,
      content: text,
      marginBottom: 1,
    });
    responseLog.add(logItem);
    // Trigger scroll update
    setTimeout(() => {
      responseLog.scrollTop = responseLog.scrollHeight;
    }, 10);
  }

  // Redirect console logs to dashboard to prevent terminal distortion
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: any[]) => {
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    appendLogMessage(`[LOG] ${text}`, palette.info);
  };
  console.error = (...args: any[]) => {
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    appendLogMessage(`[ERROR] ${text}`, palette.danger);
  };
  console.warn = (...args: any[]) => {
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    appendLogMessage(`[WARN] ${text}`, palette.warning);
  };

  renderer.on("destroy", () => {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  });

  // Populate dynamic context manifest fields
  async function updateManifest() {
    // 1. Load active skills
    try {
      const skillsDir = path.resolve(config.skillsDir);
      await fs.mkdir(skillsDir, { recursive: true });
      const dirs = await fs.readdir(skillsDir);
      const skillNames = dirs.filter((d) => !d.startsWith("."));
      skillsText.content =
        skillNames.length > 0
          ? skillNames.map((s) => `├─ ${s}`).join("\n")
          : "No active skills loaded.";
    } catch {
      skillsText.content = "Failed to load skills.";
    }

    // 2. Load core memory
    try {
      const core = await loadCoreMemory();
      memoryText.content = `[User]\n${core.human_context.substring(0, 100)}...\n\n[Project]\n${core.project_context.substring(0, 100)}...`;
    } catch {
      memoryText.content = "Failed to load memory.";
    }

    // 3. Load active tools
    const tools = globalRegistry.getAllTools();
    toolsText.content = tools.map((t) => `├─ ${t.name}`).join("\n");
  }

  // Initial populate
  await updateManifest();

  // Focus the prompt input field
  promptInput.focus();

  // Welcome message
  appendLogMessage("Welcome to Quiver Evolution Dashboard!", palette.primary);
  appendLogMessage(
    "Ready for input. Type your prompt below.",
    palette.textSecondary,
  );

  // Handle user submit
  let processing = false;
  promptInput.on("enter", async () => {
    if (processing) return;
    const value = promptInput.value.trim();
    if (!value) return;

    // Reset input
    promptInput.value = "";

    if (value === "/exit" || value === "/quit") {
      renderer.destroy();
      process.exit(0);
    }

    processing = true;
    appendLogMessage(`user> ${value}`, palette.promptUser);

    // Pre-create streaming agent message
    const agentMsg = new TextRenderable(renderer, {
      width: "100%",
      wrapMode: "word",
      fg: palette.promptAgent,
      content: "agent> Thinking...",
    });
    responseLog.add(agentMsg);

    try {
      let firstToken = true;
      await agent.prompt(value, (token) => {
        if (firstToken) {
          agentMsg.content = `agent> ${token}`;
          firstToken = false;
        } else {
          agentMsg.content = agentMsg.plainText + token;
        }
        // Force immediate scroll position update during stream
        responseLog.scrollTop = responseLog.scrollHeight;
      });

      // Update sidebar manifest in case skills or memory were modified by tools
      await updateManifest();
    } catch (err: any) {
      appendLogMessage(`[SYSTEM ERROR] ${err.message}`, palette.danger);
    } finally {
      processing = false;
    }
  });
}

run().catch((err) => {
  console.error("Dashboard launch failure:", err);
  process.exit(1);
});
