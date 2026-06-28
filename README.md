<p align="center">
  <img src="branding/logo.png" alt="Quiver" width="128">
</p>

<h1 align="center">Quiver</h1>

<p align="center">Open harness for open models</p>

---

A self-evolving coding and research harness for the terminal, and with a Desktop app. Designed to be optimised for the best open source models, with extensible tools, transparent/ editable/ portable persistent and session memories.

## Quick Start

```bash
npm install -g .
quiver init        # Set up .env with your API key
quiver             # Start a session
```

## Vision Fallback

The primary model is optimised for coding but text-only. When you attach an image or video, Quiver automatically routes the request to the best multimodal model via Ollama:

```bash
ollama pull <multimodal-model>   # Install your preferred vision model
```

Configure via `VISION_MODEL_NAME` in `.env` or Settings → Vision Model in the GUI.

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

## Tools

| Category | Tools |
|----------|-------|
| Local storage | view_file, write_file, replace_content, apply_patch, list_dir, glob, format_code, grep_search |
| System | run_command, run_tests, create_tool, log_tokens |
| Web | web_search, scrape_url, browser_control, deep_research, find_all, entity_search |
| Memory | memory_append, memory_replace, continual_learning |
| GitHub | github |
| Planning | todo_write, ask_question |
| Self-improvement | prompt_update |
| Iteration | ralph_loop |
| Agents | subagent |

## Principles

1. **Your harness, your memory** — Ability to manage context as you exactly intend.
2. **Context Transparency** — Show what enters the model call before each prompt.
3. **Explainability** — Trace user prompts, and resulting chain of thoughts, operations performed, results from tool calls by the harness.
4. **Provenance** — Facts must come from provided context, not from training.
5. **Low level Primitives** — When the right tool doesn't exist, the agent should recognize that and build the primitive it needs — not work around the absence.

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

Quiver reads a small, fixed set of environment variables from `.env` (see
`.env.example`). API keys may also be stored in the OS keychain. A **single
`OLLAMA_API_KEY`** powers the primary LLM, the Ollama adapter, and the vision
adapter — no separate LLM/vision keys are required. `LLM_API_KEY`,
`VISION_MODEL_API_KEY`, and `CONTEXT7_API_KEY` are retired.

| Variable | Required | Description |
| --- | --- | --- |
| `OLLAMA_API_KEY` | yes | Single API key for the LLM, Ollama, and vision adapters |
| `LLM_API_BASE_URL` | no | LLM API base URL (default `https://ollama.com/v1`) |
| `LLM_MODEL_NAME` | no | Primary model — source-controlled default, override only |
| `VISION_MODEL_NAME` | no | Vision model — source-controlled default, override only |
| `VISION_MODEL_BASE_URL` | no | Vision adapter base URL |
| `REQUIRE_APPROVAL_FOR` | no | Comma-separated tools needing approval |
| `QUIVER_MAX_CONTEXT_TOKENS` | no | Context window limit (default `120000`) |
| `BROWSER_HEADLESS` | no | `true`/`false` — show browser window for sign-in |
| `QUIVER_SESSION_LOG` | no | `0` to disable session logging |
| `QUIVER_SESSION_LOG_MAX_CHARS` | no | Max chars logged per session message |
| `PARALLEL_API_KEY` | optional | Powers web search, scrape, deep research, find_all |
| `GITHUB_TOKEN` | optional | GitHub tooling (issues/PRs/repos) — developers only |

Model names are source-controlled in `src/config.ts`; the first-run wizard
never asks for a model name. Cloud sync, when enabled, additionally reads
opt-in sync flags — see `docs/sync.md`.

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

Apache License