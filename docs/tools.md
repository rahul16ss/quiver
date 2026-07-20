# Quiver Tools

## Overview

Tools are single-purpose TypeScript files in `src/tools/`. Each tool exports a `Tool` object with name, description, Zod parameters, and an execute function.

## Tool Interface

```typescript
export interface Tool {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  execute: (args: any) => Promise<any> | any;
}
```

## Built-in Tools

### File Operations
- `view_file` — Read file contents with line range support
- `write_file` — Create or overwrite files
- `replace_content` — Targeted string replacement in files
- `apply_patch` — Apply unified diff patches
- `list_dir` — List directory contents
- `glob` — Find files by glob pattern
- `grep_search` — Search file contents with ripgrep
- `format_code` — Format TypeScript/JavaScript files

### Execution
- `run_command` — Execute shell commands with risk classification
- `run_tests` — Run TypeScript compilation and unit tests
- `create_tool` — Dynamically create and register new tools

### Research & Web
- `web_search` — Search the web
- `scrape_url` — Scrape web pages to markdown
- `deep_research` — Multi-hop web research with citations
- `entity_search` — Fast people/company search
- `find_all` — Verified entity discovery with match conditions

### Browser
- `browser_control` — Persistent browser session automation

### GitHub
- `github` — GitHub API operations (issues, PRs, files)

### Memory & Learning
- `memory_append` — Append to persistent memory files (auto-creates version snapshot)
- `memory_replace` — Rewrite persistent memory files (auto-creates version snapshot)
- `continual_learning` — Mine session transcripts for patterns
- `prompt_update` — Propose system prompt updates
- `log_tokens` — Parse session logs for token statistics

### Evidence & Lineage
- `evidence` — Track sources and claims during document drafting. Actions: `register_source`, `exclude_source`, `record_claim`, `update_claim`, `register_input`, `validate`, `finalize`, `status`. Writes `Evidence.json` and `Run_Record.json` alongside Office documents.

### Data Connectors
- `data_query` — Unified interface to registered data-vendor connectors. Actions: `list` (show connectors), `search` (find entities), `fetch` (get data), `status`. Auto-loads connectors from `.quiver/connectors/`. Every result carries provenance metadata.

### Agent Orchestration
- `subagent` — Spawn isolated agent processes
- `ralph_loop` — Iterative self-referential development loop (still available for explicit persistent goals; ambient goal-seeking is now the default harness behavior — see US-13.5)
- `todo_write` — Manage task checklists
- `ask_question` — Ask user clarifying questions

## Tool Sandbox

Dynamically generated tools execute in isolated worker threads with:
- Least-privilege filesystem access (glob patterns) — **enforced** via a permission-checking `fs` proxy inside the worker (US-6.4); the manifest globs are no longer advisory
- Network access control
- Shell access control
- Environment variable filtering
- Timeout limits
- Output size limits

## Tool Registry

The `ToolRegistry` class manages tool loading, hot-reloading, and OpenAI function-calling schema serialization. Tools are loaded from `src/tools/` at startup and can be dynamically created via `create_tool`.

## MCP (Model Context Protocol)

Quiver supports MCP servers as external tool providers. Configure servers in `.quiver/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "remote-api": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer token" }
    }
  }
}
```

MCP tools appear as `mcp_<server>_<tool>` in the tool list. They are transparent — calls appear in the audit trail like any built-in tool. Use `/mcp` to see connected servers.

### Supported transports:
- **stdio** — spawns a local process, communicates over stdin/stdout
- **Streamable HTTP** — POST requests to a remote MCP endpoint

### Protocol:
- Implements JSON-RPC 2.0 natively (no external SDK dependency)
- Supports `initialize`, `tools/list`, and `tools/call` methods
- Server instructions are loaded into the system prompt
## Office Documents

Quiver includes a built-in `office_doc` tool powered by [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
for creating and editing Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) documents.
No Microsoft Office installation is required.

### Installation

OfficeCLI is an external binary. If it is not found on the PATH, the tool
reports the install command rather than installing it silently:

```bash
curl -fsSL https://d.officecli.ai/install.sh | bash
```

### Usage

The `office_doc` tool supports these actions:
- `create` — Create a blank .docx, .xlsx, or .pptx file
- `add` — Add elements (paragraphs, tables, slides, cells, shapes)
- `set` — Modify element properties (text, formatting, values)
- `get` — Retrieve document elements
- `view` — View document content (text, outline, stats, issues modes)
- `query` — CSS-like selector queries
- `remove` — Remove elements
- `move` / `swap` — Reorder elements
- `batch` — Execute multiple operations in a single save cycle
- `save` / `close` — Flush changes to disk
- `validate` — Validate against OpenXML schema
- `help` — Query the schema reference for element types and properties

See `skills/office-doc/SKILL.md` for detailed usage patterns and document templates.

## Security Enforcement (wired)

The file/shell tools enforce the security modules directly, not just the agent:

- **Path sandbox** — `view_file`, `write_file`, `replace_content`, and
  `apply_patch` resolve every target through `src/security/tool_paths.ts`
  (`assertToolPathAllowed`), which canonicalizes paths, resolves symlinks, hard-
  blocks sensitive globs (`.env`, `*.pem`, `*.key`, `id_rsa`, `.git/`) and
  sensitive home dirs (`.ssh`, `.aws`, `.config`), and confines writes to the
  workspace or `~/.quiver`.
- **Atomic writes** — `write_file`, `replace_content`, and `apply_patch` write
  via `atomicWrite()` (temp → rename) with a backup recorded in
  `sessionBackups` for `/rollback`.
- **Command risk classification** — `run_command` classifies every command via
  `classifyCommand()` (risk band + approval flag) and refuses commands that
  target paths outside the workspace. The agent approval gate uses the same
  classifier so `rm -rf` prompts while `ls` runs free.
- **Generated-tool destination** — `create_tool` writes to
  `getProjectToolsDir()` (`~/.quiver/projects/{id}/tools/`), never to
  `src/tools/`.

## Slash Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `/mcp` | | Show connected MCP servers and tool counts |
| `/consent` | `/cg` | Toggle consent gate (pre-action summary before model calls) |
| `/promote` | `/pm` | Promote scratch drafts to real files (`/promote all \| <path> \| list`) |
| `/memory-history` | `/mh` | Show version history for a memory file |
| `/memory-rollback` | `/mr` | Restore a previous version of a memory file |
| `/memory-diff` | `/md` | Compare two versions of a memory file |
| `/sandbox` | | Show OS sandbox status |
| `/update` | | Check for Quiver updates |
