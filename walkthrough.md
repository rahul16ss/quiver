# Quiver Hardening & Refactoring Walkthrough

All tasks in the refactoring and security hardening program have been successfully completed. Typechecking passes cleanly, and all 143/143 checks in the acceptance test suite are green.

## 🛠️ Summary of Accomplished Changes

### 1. Environment Credential Hardening (`src/subagents/pool.ts`, `src/tools/subagent.ts`)
- Configured subagent spawn functions (`spawnSubagent` in `pool.ts` and `runSubagent` in `subagent.ts`) to scrub standard credential names (such as `OLLAMA_API_KEY`, `GITHUB_TOKEN`, `PARALLEL_API_KEY`) from `process.env` before executing tools or checkers.

### 2. Symlink Traversal Escape Vulnerability (`src/subagents/sandbox.ts`)
- Restructured `validateSubagentFiles` to resolve paths using `fsSync.realpathSync` relative to the actual copy-on-write scratchpad directory, ensuring symlink targets are properly evaluated and blocked if they escape the workspace boundary.

### 3. Unified Secrets Redaction (`src/agent.ts`, `src/session_logger.ts`, `src/logger.ts`)
- Replaced duplicate patterns and redaction routines with the canonical helper imported directly from `src/security/secrets.ts`.

### 4. routed Adapters for Prompt & Citation Parsing (`src/prompt/assembler.ts`, `src/agent.ts`)
- Channeled prompt construction through the active model adapter's `buildSystemPrompt` function.
- Routed the citation extraction logic through the adapter's `parseMemoryCitations` function instead of directly using the parser.

### 5. Maker-Checker Logic Fix (`src/lifecycle.ts`)
- Adjusted the `wrapToolCall` execution sequence to execute changes first, validating them post-execution, and performing an automatic rollback of the last file change if the checker rejects or requests a revision of the modification.

### 6. File-backed Rollback Subcommand (`src/cli.ts`)
- Modified `/rollback last` to query local `.quiver-backups` directories recursively and restore the target file using the most recently written backup file across different process lifecycles.

### 7. Synchronous Windows Keychain Support (`src/secrets/keychain.ts`)
- Added Windows support using `powershell` P/Invoke to `CredReadW` inside `getCredentialSync`.

### 8. Strict `.env` Unix Permissions (`src/init.ts`)
- Modified the onboarding wizard to automatically restrict `.env` permissions to owner-only (`0600`) after copy/write actions.

### 9. Newly Created Memories Fallback (`src/memory/decay.ts`)
- Modified the decay formula to check the filesystem creation/modification time of memory files when `last_used` is null, preventing new files from being immediately flagged for archival.

---

## 🧪 Verification & Acceptance Status

Running `npm test` yields a clean pass of all tests:

```bash
🧪 Quiver — Spec Acceptance Gate (checker-owned)
==================================================

📐 Running Spec Acceptance Contract (vendor gate)
==================================================
   ✔ PASS  ... (All 143 tests pass)
   ✔ PASS  [DoD] TSC-CLEAN

  ✔ All 143 spec acceptance checks met.
🎉 All spec acceptance checks passed.
```
