# Quiver Memory

## Overview

Quiver implements multiple distinct memory structures, all stored as plain text files that the user can grep, edit, version-control, and sync naturally.

## Memory Layers

### 1. Core Memory (`~/.quiver/core.json`)
Global identity and human context, shared across all projects:
- `identity` — Who the agent is
- `human_context` — Who the user is

### 2. Project Memory (`~/.quiver/projects/{project_id}/memory/`)
Per-project memory files:
- `project.json` — Project context and metadata
- `persona.txt` — Agent behavior notes
- `user-preferences.md` — User preferences
- `workspace-facts.md` — Workspace facts
- `facts.jsonl` — Structured memory facts with provenance

### 3. Session Memory (`~/.quiver/projects/{project_id}/.sessions/`)
- Session logs (JSON)
- Checkpoints for crash recovery
- Compacted conversation archives
- Offloaded large tool results

## Memory Facts Schema

```json
{
  "schema_version": 1,
  "id": "mem_01J...",
  "type": "workspace_fact",
  "content": "The frontend uses Vite.",
  "source_session": "sess_01J...",
  "source_timestamp": "2026-06-28T12:00:00Z",
  "confidence": "high",
  "privacy": "project",
  "reviewed": false,
  "created_at": "2026-06-28T12:05:00Z",
  "last_used_at": null,
  "hit_count": 0
}
```

## Memory Types
- `workspace_fact` — Facts about the project structure
- `user_preference` — User's coding preferences
- `code_behavior` — How code behaves or should behave
- `architecture_note` — Architecture decisions
- `error_pattern` — Common error patterns
- `skill_accretion` — Learned skills

## Privacy Labels
- `public` — Safe for remote models and cloud sync
- `project` — Project-scoped, only for approved models
- `private` — Only sent to remote with explicit opt-in
- `secret` — Never sent to remote, never synced

## Review Queue

Extracted facts start as `pending`. User can:
- **Accept** — Fact enters active prompt assembly
- **Edit** — Modify content then accept
- **Reject** — Delete the fact
- **Pin** — Mark as high confidence
- **Expire** — Mark as low confidence

CLI: `/memory review`
GUI: Memory review panel

## Citation Tracking

The harness adapter enforces citation tags in model output:
```xml
<memory-citation doc="user-preferences.md">...</memory-citation>
```

Citations are parsed and tracked in `usage_stats.json`:
- `hit_count` — Number of times cited
- `last_used` — Last citation timestamp

## Memory Decay

Unused memories decay with a half-life function:
```
decay_score = hit_count × 0.5^(elapsed_days / half_life_days)
```

Default half-life: 30 days. Memories below the archival threshold (0.5) are candidates for archival.

## Trace Analysis

On session completion, the `afterAgent` lifecycle hook runs a lightweight LLM extraction pass:
1. Feeds session trace to a local or fast remote model
2. Extracts preferences, errors, and architecture facts
3. New facts enter the pending review queue