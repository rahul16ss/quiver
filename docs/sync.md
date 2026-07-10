# Quiver Sync

## Overview

**Legacy / advanced, opt-in feature — off by default.** Cloud folder sync is a
developer-oriented convenience for working across multiple machines; it is
intentionally not part of the finance-workflow surface (see `docs/advanced.md`).
Quiver may detect candidate cloud folders but must not sync until the user
explicitly opts in.

## Configuration

Enable sync via one of the consent sources (`src/cloud_sync.ts`):
- Environment variable: `QUIVER_CLOUD_SYNC_ENABLED=1`
- `~/.quiver/sync.json` with `"enabled": true` (written by the GUI settings toggle)

Set the sync destination via:
- Environment variable: `QUIVER_CLOUD_SYNC_PATH` (any synced folder)
- GUI settings, or auto-detected candidate cloud folders (detection alone never enables sync)

## What Syncs

- Memory files (persona.txt, user-preferences.md, workspace-facts.md)
- Project context (project.json)
- Reviewed memory facts (facts.jsonl) — only `public` and `project` privacy labels

## What Does NOT Sync

By default, the following are excluded:
- `.env` files
- Credential files
- Raw private session logs
- Generated tool binaries
- Secret-labeled memory facts
- API keys and tokens

## Encryption

Sync uses client-side symmetric key encryption (AES-256-GCM):
- The passphrase/key is stored in the OS credential store
- Contents are encrypted locally before writing to the shared folder
- File hashes are checked to resolve sync concurrency conflicts

## Atomic Writes

Writes to the sync folder are atomic (temp-write-then-rename). If a conflict occurs:
1. Both versions are preserved (the cloud copy is kept as a `.conflict.<timestamp>` file)
2. The conflict is surfaced to the user and logged to the sync audit chain

## Candidate Detection

Quiver detects common cloud folder paths:
- iCloud (`~/Library/Mobile Documents/com~apple~CloudDocs`)
- Dropbox (`~/Dropbox`)
- OneDrive (`~/OneDrive`)
- Google Drive (`~/Google Drive`)

Detection does not enable sync — the user must explicitly opt in.