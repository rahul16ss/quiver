<p align="center">
  <img src="branding/logo.png" alt="Quiver" width="128">
</p>

<h1 align="center">Quiver</h1>

<p align="center">A self-evolving coding and research agent for the terminal.</p>

---

Powered by GLM-5.2, with 27 tools, persistent memory, cloud sync, and the ability to write its own tools at runtime.

## Quick Start

```bash
npm install -g .
quiver init        # Set up .env with your API key
quiver             # Start a session
```

## Architecture

```
~/.quiver/                          # Global (shared across projects)
├── core.json                        # Identity + user context
├── skills/                          # Skills (reusable procedures)
│   ├── system-prompt/SKILL.md      # The system prompt (editable)
│   └── cli-for-agents/SKILL.md     # CLI design patterns
└── projects/{name}/
    ├── memory/                      # Per-project memory
    │   ├── persona.txt              # Agent behavior notes
    │   ├── human.txt                # User details
    │   ├── project.json             # Project context
    │   ├── user-preferences.md      # Auto-learned preferences
    │   └── workspace-facts.md       # Auto-learned facts
    └── .sessions/                   # Session logs + state
```

Cloud sync: auto-detects Google Drive, OneDrive, Dropbox, iCloud. Syncs to `{cloud}/Quiver/` after every turn. No OAuth — just files in a folder.

## Tools (27)

| Category | Tools |
|----------|-------|
| Files | view_file, write_file, replace_content, apply_patch, list_dir, glob, format_code, grep_search |
| System | run_command, run_tests, create_tool, log_tokens |
| Web | web_search, scrape_url, search_docs, browser_control, deep_research, find_all, entity_search |
| Memory | memory_append, memory_replace, continual_learning |
| GitHub | github |
| Planning | todo_write, ask_question |
| Self-improvement | prompt_update |
| Iteration | ralph_loop |

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/tools` | List all tools |
| `/config` | Show configuration |
| `/model <name>` | Change model |
| `/compact` | Compact conversation history |
| `/reset` | Reset conversation (keeps memory) |
| `/resume` | Resume a previous session |
| `/exit` | End session (auto-saves) |

## CLI Flags

| Flag | Description |
|------|-------------|
| `--continue`, `-c` | Resume most recent session |
| `--resume`, `-r` | Pick a session to resume |
| `--list-sessions` | List saved sessions |
| `--single-turn "prompt"` | Run one prompt and exit |
| `--json` | Structured JSON output (for scripts) |
| `--dry-run`, `-n` | Preview tool actions without executing |

## Configuration

See `.env.example` for all options. Key settings:

```bash
LLM_API_KEY=          # Required — get yours at ollama.com
PARALLEL_API_KEY=     # Optional — powers web search, deep research
GITHUB_TOKEN=         # Optional — powers GitHub tool
REQUIRE_APPROVAL_FOR= # Comma-separated tools needing approval
QUIVER_MAX_CONTEXT_TOKENS=900000  # Context window limit
```

## License

MIT