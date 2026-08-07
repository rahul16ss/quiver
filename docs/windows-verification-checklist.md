# Windows verification checklist (owner)

Quiver's customer path is Windows-first. The items below cannot be truthfully
signed off from the macOS development machine. Run them on a real Windows
laptop (Windows 10/11, x64 or arm64) before calling the release complete.

There is **no Electron / NSIS packaged desktop app**. The interactive surface is
the **loopback browser UI** served by the harness daemon (`npm start` /
`npm run harness` → open the printed `http://127.0.0.1:…` URL).

## Install and launch

1. Install Node.js LTS and clone or unpack the engagement build.
2. Run `npm ci` (or the engagement install script).
3. Install OfficeCLI with the official Windows distribution
   (`officecli-win-x64.exe` / `officecli-win-arm64.exe`, PowerShell installer or
   Scoop). If not on `PATH`, set `QUIVER_OFFICECLI_PATH`.
4. Run `npm start` (or `quiver` from a global install). Confirm the terminal
   prints a loopback URL and the browser opens the three-pane workspace
   (context · conversation · activity).
5. Confirm first launch reaches onboarding / settings, then the Associate
   workspace.

## Credentials

6. Enter an API key in onboarding/Settings (`OPENROUTER_API_KEY` preferred for
   cloud; or local `LLM_API_*`).
7. Confirm it is stored in **Windows Credential Manager** (not in plain JSON
   config with a live secret).
8. Quit and relaunch — the agent must hydrate the key without re-entry.
9. Confirm config files do not contain live `apiKey` / `llmApiKey` values.

## Daemon / autostart

10. Run `quiver daemon install` (or the documented equivalent).
11. Confirm Task Scheduler has task `QuiverDaemon` (ONLOGON).
12. Sign out / sign in and confirm the daemon is reachable (`/health`).
13. Open the printed browser URL; it should attach to the running daemon
    session.

## Office and demos

14. Run `npm run demo:ic-memo` (or start the IC-memo pack from the workflow
    picker) and confirm the Word memo + Evidence.json land correctly under
    OneDrive/local paths.
15. Create/edit a `.docx` into a synced OneDrive folder; confirm lock-retry
    behavior when the sync client briefly locks the file.
16. Open a deliverable card with missing Evidence.json — UI must show
    **not reviewable — evidence invalid/missing**, not "ready".

## Sensitivity and gates

17. With finance-client profile / consent gate on: send a prompt and confirm
    the consent overlay cannot be dismissed with Escape/backdrop.
18. With high-sensitivity / air-gap profile and no approved local model:
    confirm the turn is refused with a clear message (no cloud send / network
    tools blocked).

## Sign-off

| Check | Pass? | Notes |
| :--- | :--- | :--- |
| Browser UI launch | | |
| Credential Manager storage | | |
| Daemon autostart | | |
| IC memo demo | | |
| Evidence hard gate | | |
| Consent / air-gap | | |

Owner sign-off: ________________  Date: ________
