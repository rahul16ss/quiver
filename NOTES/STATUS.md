# Quiver status — open items only

What still needs credentials, licensing, or a product decision. Everything else
is in the code and tests; do not treat this file as a changelog.

| Item                                                                                                                                          | Blocker                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Live OpenRouter ZDR + per-MIME CapabilityRegistry certs                                                                                       | `OPENROUTER_API_KEY` + `QUIVER_LIVE_*`           |
| Live Parallel search / monitor / webhook                                                                                                      | `PARALLEL_API_KEY` (+ `PARALLEL_WEBHOOK_SECRET`) |
| Live Microsoft Graph / Google Drive                                                                                                           | Tokens + item ids                                |
| OfficeCLI binary checksum pins                                                                                                                | Licensed binary + digest                         |
| 9 scaffold packs → demo-ready Office fixtures                                                                                                 | Engagement / pack work                           |
| ~~Chat turns as GoalContract~~ DONE — chat runs on a chat-mode ExecutionEngine (`createChatEngine`); the Agent is the delegated turn executor | —                                                |
| Visual browser-UI walkthrough with screenshots                                                                                                | Manual release gate                              |
| PromptRegistry fully replacing Agent assembler                                                                                                | Deferred                                         |
| Ambient job kind product handlers                                                                                                             | Deferred (unknown kinds → DLQ)                   |

## Current production shape (facts)

- Composition root: `src/harness/production-runtime.ts` (`buildProductionRuntime`)
- Buyer surface: loopback browser UI `src/harness/ui/` via harness daemon (`npm start`)
- Cloud model gateway: OpenRouter · Public web research: Parallel
- Gates: `npm test` · `npx tsc --noEmit` · three demos · daemon smoke · visual browser walkthrough

Cross-project: `/Users/rahul/PROJECTS.md` · Public claims: Conviction Studio
`docs/first-customer/capability-truth-table.md`
