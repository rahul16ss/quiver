<p align="center">
  <img src="branding/logo.png" alt="Quiver" width="128">
</p>

<h1 align="center">Quiver</h1>

<p align="center">A self-evolving coding and research agent for the terminal.</p>

---

Powered by GLM-5.2, with 28 tools, persistent memory, cloud sync, and the ability to write its own tools at runtime.

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

## Tools (28)

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
| Agents | subagent |

## Principles

1. **Read Before Write** — Always read a file before modifying it. Enforced at the code level.
2. **Minimal Edits** — Prefer targeted edits over full rewrites. Use apply_patch for multi-file diffs.
3. **Verify After Changes** — Run tests after code changes. Fix failures before declaring success.
4. **Explore First** — Understand project structure before making changes.
5. **No Hallucination** — Never fabricate file paths, function names, or APIs.
6. **Error Recovery** — When a tool fails, analyze, adjust, and retry.
7. **Progressive Disclosure** — Work incrementally — make a change, verify it, then move on.
8. **No Silent Actions** — Every action is visible to the user.
9. **Provenance** — Facts must come from files read, not from memory or inference.
10. **Reversibility Awareness** — Distinguish reversible from irreversible actions.
11. **Task Tracking** — For multi-step tasks, create a todo list.
12. **Context Transparency** — Show what enters the model call before each prompt.

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
REQUIRE_APPROVAL_FOR= # Comma-separated tools needing approval
QUIVER_MAX_CONTEXT_TOKENS=900000  # Context window limit
```

## GUI

Quiver includes an Electron-based GUI with streaming chat, tool call visualization, approval gates, and a context transparency panel:

```bash
npm run gui
```

The GUI shares the same `~/.quiver/` memory and sessions as the CLI.

## Self-Improvement

Quiver can propose updates to its own system prompt using `prompt_update`. The user reviews, edits, or rejects proposed changes — the agent never modifies the prompt directly.

`continual_learning` mines past session transcripts for high-signal patterns and writes them to `user-preferences.md` and `workspace-facts.md` in the project memory directory.

## License

MIT