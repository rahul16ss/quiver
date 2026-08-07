# Working on Quiver — read this first

**Source of truth for cross-project context:** `/Users/rahul/PROJECTS.md`

Repo-local:

- `docs/product/user-stories.md` — design source for the buyer surface
- `SPEC.md` — technical spec (gitignored; §19 status table). Build in §19 order.
- `NOTES/STATUS.md` — open external/deferred items only
- Buyer surface: loopback browser UI (`src/harness/ui/`). Launch: `npm start`

Hard rules:

1. `npm test` is checker-owned — never edit tests to pass.
2. Release gate: `npm test` · `npx tsc --noEmit` · three demos · daemon smoke ·
   visual browser-UI walkthrough with screenshots you actually read.
3. Public claims: Conviction Studio capability truth table only. Never claim
   data stays local by default, Quiver-signed ZDR, or "compliance-ready".
4. Business surfaces: **Draft only / Draft and research / Assisted** — never "yolo".
5. Commits: `Co-Authored-By: Quiver <quiver@convictionstudio.com>`
6. Never write into the install when `QUIVER_PROTECTED_DIR` is set.

Principles: [`docs/principles.md`](docs/principles.md).
