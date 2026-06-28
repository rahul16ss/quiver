# Quiver Sync

## Overview

Optional filesystem-based sync for working across multiple machines. Sync is disabled by default — Quiver may detect candidate cloud folders but must not sync until the user opts in.

## Configuration

Set the sync destination via:
- Environment variable: `QUIVER_CLOUD_SYNC_PATH`
- Global config: `QUIVER_CLOUD_SYNC_PATH` in `~/.quiver/config.json`
- GUI settings

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
1. Both versions are preserved
2. A conflict resolution prompt is surfaced to the user

## Candidate Detection

Quiver detects common cloud folder paths:
- iCloud (`~/Library/Mobile Documents/com~apple~CloudDocs`)
- Dropbox (`~/Dropbox`)
- OneDrive (`~/OneDrive`)
- Google Drive (`~/Google Drive`)

Detection does not enable sync — the user must explicitly opt in.