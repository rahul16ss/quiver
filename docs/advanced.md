# Advanced / developer capabilities

Developer-oriented documentation for capabilities that exist in Quiver but are
intentionally not part of the finance-workflow surface or the primary README.
Nothing here should be presented to business users or clients without an explicit
engagement decision.

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
| `/mcp` | Show MCP server connections |
| `/autonomy` | Trust tiers & grants (add/remove grants, sandbox) |
| `/sandbox` | Toggle path sandbox on/off (highest trust tier required to disable) |

## Trust tiers (internal names)

Quiver's permissioning is an incremental ladder from most-restrictive to
fully-unrestricted, persisted per project to `~/.quiver/projects/<id>/permissions.json`.

| Tier | Grants | Read scope | Sandbox |
|------|--------|-----------|---------|
| `observe` | none — every state change prompts | workspace only | on |
| `propose` | + workspace writes, todo/memory | workspace | on |
| `build` | + safe/moderate shell, web tools | workspace + home | on |
| `operate` | + destructive, privileged, network, browser | filesystem | on |
| top tier (internal alias `yolo`) | everything | filesystem | off |

The internal top-tier alias remains for backwards compatibility with tests and
developer muscle memory. It must not appear in the desktop business UI, the primary
README, client documentation, demos, screenshots, or training material. Business
surfaces use: **Draft only / Draft and research / Assisted**.

Tiers are cumulative. Raw grants can be mixed via `/autonomy add|remove|set`.
Approval prompts offer **(y)** once, **(a)** all-similar-this-session, or **(N)**.

## Verification: maker-checker internals

There is one verification primitive — the isolated checker (`runChecker`), which
runs the acceptance contract (including the always-on `tsc` check) on an isolated
scratchpad. Three behaviors are driven by it:

1. **Per-change verification** — every high-risk change is verified before it
   commits; on revise/reject it rolls back and hands evidence to the model.
2. **Goal-loop** — the agent loop does not stop until the checker has approved
   every change and the completion check passes.
3. **Completion self-heal** — at task completion the checker runs once in full mode
   to catch non-targeted regressions; capped at 5 rounds (`QUIVER_AMBIENT_MAX_ROUNDS`).

`/override` is the manual escape hatch. Customer-facing name for all of this:
**verified before delivery** — do not use "maker-checker" with clients.

## Mid-run intervention

Press **Esc** while the agent runs to inject a steering message at the next step
boundary. **Ctrl+C** aborts the active generation (twice to exit).

## Full tool surface

| Category | Tools |
|----------|-------|
| Local storage | view_file, write_file, replace_content, apply_patch, list_dir, glob, format_code, grep_search |
| System | run_command, run_tests, create_tool, log_tokens |
| Web | web_search, scrape_url, browser_control, deep_research, find_all, entity_search |
| Memory | memory_append, memory_replace, continual_learning |
| GitHub | github |
| Planning | todo_write, ask_question |
| Prompt maintenance | prompt_update (user reviews every proposed change) |
| Iteration | ralph_loop |
| Agents | subagent |
| Office | office_doc (via OfficeCLI) |
| MCP | external tools via `.quiver/mcp.json` |

`create_tool` (runtime tool synthesis), `github`, `subagent`, `ralph_loop`, and
`prompt_update` are developer capabilities. They are subject to the same approval
gates as everything else, but they are not part of the finance-workflow story and
should not be promoted in client-facing material.

## MCP support

Configure servers in `.quiver/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

MCP tools appear as `mcp_<server>_<tool>` and are transparent in the audit trail.
See `.quiver/mcp.example.json`.

## Cloud folder sync (legacy / opt-in)

Folder-based sync to `{cloud}/Quiver/` (Google Drive, OneDrive, Dropbox, iCloud)
exists but is **disabled by default and strictly opt-in** — detecting a cloud folder
is never consent. Do not enable it for client engagements unless it is explicit,
documented, and consistent with the client's security policy. See `docs/sync.md`.

## Vision fallback

The primary model is text-only. Attach an image or video and Quiver routes to a
multimodal model via Ollama (`VISION_MODEL_NAME`, or Settings → Vision Model in the GUI).

## CLI flags

| Flag | Description |
|------|-------------|
| `--continue`, `-c` | Resume most recent session |
| `--resume`, `-r` | Pick a session to resume |
| `--list-sessions` | List saved sessions |
| `--single-turn "prompt"` | Run one prompt and exit |
| `--json` | Structured JSON output (for scripts) |
| `--dry-run`, `-n` | Preview tool actions without executing |

## Feature flags (internal)

| Variable | Default | Description |
| --- | --- | --- |
| `QUIVER_AMBIENT` | on | Completion self-heal + goal-loop; `=0` to disable |
| `QUIVER_LOG_RETENTION_DAYS` | 30 | Auto-purge old session logs (`0` = keep forever) |
| `QUIVER_LIFECYCLE_TRACE` | off | One-line trace of lifecycle hooks |
