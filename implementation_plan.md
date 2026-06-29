# Implementation Plan — Quiver Conformance Audit & Gaps Alignment

> **Status (re-audit 2026-06-28): WIRING COMPLETE, ALL GAPS CLOSED — GATE GREEN.** All
> architectural integrations below are wired into the live `src/agent.ts` loop and
> the tools (verified by the `WIRE-*` integration checks in `tests/spec_acceptance_tests.ts`).
> The checker-owned acceptance gate (`npm test`, 122 checks) is GREEN at **122/122 met, 0
> failing** — the 11 dead-code wiring gaps + 2 maker-checker checks (`MAKER-CHECKER-SEPARATION`/
> `MAKER-CHECKER-SCRATCHPAD`) are closed at the acceptance bar; see `tests/ACCEPTANCE_CONTRACT.md`.
> `npx tsc --noEmit` is clean. `npm test` is the only live verdict. Summary of what shipped:
>
> - **Path sandbox** enforced in `view_file`/`write_file`/`replace_content`/`apply_patch`
>   via `src/security/tool_paths.ts` (`assertToolPathAllowed`), incl. symlink-normalization
>   for non-existent files.
> - **Command risk classification** (`classifyCommand`) wired into `run_command` and
>   the agent approval gate (approval bound to risk band, not tool name).
> - **Hash-based read-before-write** (`FileReadHistory`, SHA-256 + mtimeMs) replaces
>   the `Set<string>` tracker.
> - **Atomic writes** (`atomicWrite` temp→rename + backup) in the file-mutating tools.
> - **`create_tool`** writes to `getProjectToolsDir()` (`~/.quiver/projects/{id}/tools/`).
> - **Provider abstraction** (`getActiveProvider().streamChat()`) replaces inline
>   `fetch()`; `ModelEvent.toolCallIndex` added for correct parallel tool-call accumulation.
> - **Adapter abstraction** (`getAdapterForModel`) selects specific adapters before
>   the catch-all default; tool defs routed through `adapter.formatTools()`.
> - **Lifecycle hooks** fire in the real loop (`wrapModelCall`/`wrapToolCall`); the
>   maker-checker gate is **always-on for high-risk ops** (US-15.1 — no longer opt-in
>   behind `QUIVER_MAKER_CHECKER`); the hook trace via `QUIVER_LIFECYCLE_TRACE=1`.
> - **Prompt assembler** (`assemblePrompt`, deterministic 9-section + `SECURITY_PREAMBLE`)
>   replaces ad-hoc `buildSystemPrompt` concatenation.
> - **Token budget** (`calculateBudget`/`shouldBlockSubmission`, 85% formula) gates
>   the payload and forces compaction when over-limit.
> - **Checkpoint/crash recovery** (`CheckpointManager` per turn, `detectCrashedSession`
>   on launch in `cli.ts`).
> - **Diagnostics** (`ConsecutiveFailureTracker` + `createDiagnosticBlock`) on tool errors.
> - **Memory privacy/citations/decay** (`filterByPrivacy`, `parseMemoryCitations`/
>   `updateUsageStats`, `getArchivalCandidates`) applied by the loop.
> - **Stable `project_id`** UUID (`getProjectId`), and **keychain shell-escaping**
>   + Windows `CredRead` retrieval in `src/secrets/keychain.ts`.
>
> The original gap analysis and proposed changes follow for historical context.

## User Review Required

> [!IMPORTANT]
> **Key Architectural Integrations:**
> 1. We will wrap all tool executions in `agent.ts` with centralized `PathPolicy` validation. Any tool touching file/directory paths will be blocked if it attempts to access files outside the workspace root or matches blocked files (e.g. `.env`, `.git/`).
> 2. We will replace the raw `SessionLogger` with the unified `Logger` in `agent.ts` to automatically populate the SHA-256 cryptographic audit chain.
> 3. We will integrate `CheckpointManager` and `SessionManager` into the core loop of `agent.ts` to write checkpoints after every turn and action.
> 4. We will modify `create_tool` to JIT-compile tools via esbuild/typescript, request user approval of source code in the CLI, write to project-local directories, and execute them in an isolated sandbox worker.
> 5. We will isolate `subagent` tools using scratchpads that clone the workspace (excluding build/VCS dirs) and enforce recursion limit depth check ($\le 2$) via env variables.
> 6. We will update the first-run wizard in `init.ts` to store credentials in the OS Keychain/Credential Store when available, falling back to a locked `.env` file (`0600` permissions) if unavailable, and hydrate the memory config on startup.

## Proposed Changes

---

### Core Loop & Security Centralization

#### [MODIFY] [agent.ts](file:///Users/rahul/quiver/src/agent.ts)
- Import `createDefaultPolicy`, `checkPathAllowed` (for path sandboxing), `targetsOutsideWorkspace` (for command path verification), and `Logger` (for unified logging & audit chain).
- Instantiate `this.pathPolicy = createDefaultPolicy(process.cwd());` in constructor.
- Replace `this.logger = new SessionLogger();` with `this.logger = new Logger();`.
- In `prompt()`:
  - Initialize `CheckpointManager` at turn start.
  - On launch, check `detectCrashedSession` and prompt/handle crashed sessions (integrated in `cli.ts`).
  - Write checkpoints via `CheckpointManager.checkpoint()` after every turn and action.
- In tool execution block:
  - Centralize path policy checks: check if any path argument (`filePath`, `directoryPath`, `directory`, `cwd`, etc.) violates path policy, and throw/return error if so.
  - Parse unified patches inside `apply_patch` and assert all target paths match path policies.
  - Assert that modified files in `apply_patch` have been read in the session and match their content hashes (CAS compare-and-swap).
  - Verify that shell commands in `run_command` do not target files outside the workspace root using `targetsOutsideWorkspace`.
  - Record file reads (`logFileRead`) and file writes (`logFileWrite`) in the unified logger.
  - Run dynamic tools inside the worker sandbox (`executeInSandbox`) instead of importing them directly in-process.

#### [MODIFY] [cli.ts](file:///Users/rahul/quiver/src/cli.ts)
- Hydrate credentials from the OS credential store asynchronously on startup via `getCredential("OLLAMA_API_KEY")` and set it in `config.llmApiKey`.
- At startup, check for crashed sessions using `detectCrashedSession(getProjectName())`. If found, prompt the user to:
  - **Resume:** Load the crash checkpoint.
  - **Archive:** Move checkpoints to the archive folder.
  - **Discard:** Delete the crashed checkpoints.
- Bind the checkpoint manager's verify step to detect session alterations.

---

### Secret Store & Onboarding

#### [MODIFY] [init.ts](file:///Users/rahul/quiver/src/init.ts)
- Import `isKeychainAvailable`, `setCredential` from `src/secrets/keychain.ts`.
- In `runInitWizard()`:
  - Check if OS credential store is available.
  - If available, save API key via `setCredential("OLLAMA_API_KEY", apiKey)` and exclude it from `config.json`.
  - If unavailable, fall back to writing to `.env`. Warn the user, set file permissions to owner-only (`0600`), and ensure `.gitignore` contains `.env`.

#### [MODIFY] [logger.ts](file:///Users/rahul/quiver/src/logger.ts)
- Add a general-purpose `logEvent(type: string, data: any)` method to maintain full backwards compatibility with any existing calls from other components.

---

### Sandbox & Runtime Tools

#### [MODIFY] [create_tool.ts](file:///Users/rahul/quiver/src/tools/create_tool.ts)
- Write TS code to the project tools directory (`getProjectToolsDir()`) instead of the main application source directories.
- Run JIT compilation using `compileTool(code, name)` from `src/tools/runtime.ts`.
- Prompt the user to inspect the source code and approve it before loading.
- Once approved, call `approveTool(name, hash)` and load the tool.

#### [MODIFY] [registry.ts](file:///Users/rahul/quiver/src/registry.ts)
- Import `getProjectToolsDir`, `isToolApproved` and `hashSource`.
- In `loadAll()`:
  - Scan the project tools directory (`getProjectToolsDir()`) in addition to default tools.
  - For each tool, read the TS file, calculate the hash, and check if it is approved via `isToolApproved`.
  - If approved, load its compiled `.mjs` file.
- In `loadToolFile()`:
  - Wrap the `execute` method of any project-local dynamic tool to run in the sandbox worker using `executeInSandbox` from `sandbox.ts`.

#### [MODIFY] [apply_patch.ts](file:///Users/rahul/quiver/src/tools/apply_patch.ts)
- Export the `parsePatch` function and `PatchFile` interface so `agent.ts` can parse patches for verification.
- Modify `applyPatchFile` to write content atomically using `atomicWrite` from `src/fs/atomic_write.ts`.

---

### Subagent Pool & Isolation

#### [MODIFY] [subagent.ts](file:///Users/rahul/quiver/src/tools/subagent.ts)
- Enforce recursion depth limits: check if `process.env.QUIVER_RECURSION_DEPTH` exceeds 2, and throw an error.
- Increment recursion depth when spawning the subagent.
- Integrate the task with `SubagentPool` from `src/subagents/pool.ts` to manage concurrency limits and isolated workspace scratchpads.

#### [MODIFY] [pool.ts](file:///Users/rahul/quiver/src/subagents/pool.ts)
- Replace the invalid `-p` CLI flag with `--single-turn` in `spawnSubagent`.
- In development/test mode, spawn using `tsx` on `cli.ts` instead of `node` on `cli.js` to prevent failures when compiled JS files do not exist.

#### [MODIFY] [sandbox.ts](file:///Users/rahul/quiver/src/subagents/sandbox.ts)
- In `createScratchpad`, copy all files from the workspace root into the scratchpad directory recursively, excluding VCS/build directories (`.git`, `node_modules`, `.sessions`, `.quiver-backups`, and the scratchpad directory itself).

---

### Testing Suite Alignment

#### [NEW] [cli_subprocess.test.ts](file:///Users/rahul/quiver/tests/e2e/cli_subprocess.test.ts)
- A true E2E CLI test suite that spawns the CLI (`npx tsx src/cli.ts`) as a subprocess with different flags and inputs:
  - Verify that running a command to edit files outside the workspace is denied.
  - Verify that blind file writes (without reading first) are denied.
  - Verify that dangerous commands block or fail.
  - Verify that first-run onboarding works correctly under an isolated temporary home directory context.

#### [MODIFY] [spec_conformance_tests.ts](file:///Users/rahul/quiver/tests/spec_conformance_tests.ts)
- Add conformance tests for:
  - Cryptographic audit chain verification via `verifyAuditChain` in `CheckpointManager`.
  - Tool JIT compilation and worker sandbox execution using `compileTool` and `executeInSandbox`.
  - Subagent workspace cloning and recursion depth blocking.

## Verification Plan

### Automated Tests
- Run the unified test runner:
  ```bash
  npm test
  ```
  Ensure all unit, conformance, and CLI subprocess E2E tests pass successfully.

### Manual Verification
- Run Quiver in terminal interactively and verify:
  - Onboarding initiates correctly when `~/.quiver/core.json` is missing.
  - Dynamic tool creation prompts for inspection/approval and runs securely in sandbox.
  - Command path traversal outside workspace is blocked.
  - Subagents run in isolated directories with cloning.
