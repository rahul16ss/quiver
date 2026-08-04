# Windows verification checklist (owner)

Quiver's customer path is Windows-first. The items below cannot be truthfully
signed off from the macOS development machine. Run them on a real Windows
laptop (Windows 10/11, x64 or arm64) before calling the release complete.

## Install and launch

1. Build or download the NSIS installer (`npm run dist:win` from macOS produces
   `dist-electron/*.exe`).
2. Install on a clean Windows user profile.
3. Confirm first launch opens onboarding, then the Associate workspace.
4. Confirm the packaged app finds `officecli` via PATH or
   `QUIVER_OFFICECLI_PATH` (install with the official PowerShell installer or
   Scoop).

## Credentials

5. Enter an API key in onboarding/Settings.
6. Confirm it is stored in **Windows Credential Manager** (not in
   `%APPDATA%\Quiver\quiver-config.json`).
7. Quit and relaunch — the agent must hydrate the key without re-entry.
8. Confirm `quiver-config.json` contains empty `apiKey` / `llmApiKey` fields.

## Daemon / autostart

9. Run `quiver daemon install` (or the GUI equivalent).
10. Confirm Task Scheduler has task `QuiverDaemon` (ONLOGON).
11. Sign out / sign in and confirm the daemon is reachable (`/health`).
12. Open the desktop app; it should attach to the running daemon session.

## Office and demos

13. Run `npm run demo:ic-memo` (or the GUI "Run workflow demo") and confirm the
    Word memo + Evidence.json land correctly under OneDrive/local paths.
14. Create/edit a `.docx` into a synced OneDrive folder; confirm lock-retry
    behavior when the sync client briefly locks the file.
15. Open a deliverable card with missing Evidence.json — UI must show
    **not reviewable — evidence invalid/missing**, not "ready".

## Sensitivity and gates

16. With finance-client profile / consent gate on: send a prompt and confirm
    the consent overlay cannot be dismissed with Escape/backdrop.
17. With high-sensitivity config and no local model: confirm the turn is
    refused with a clear message (no cloud send).

## Sign-off

| Check | Pass? | Notes |
|---|---|---|
| NSIS install | | |
| Keychain (Credential Manager) | | |
| Task Scheduler autostart | | |
| officecli on PATH | | |
| IC memo demo | | |
| Evidence-invalid UI | | |
| Consent non-dismissible | | |
| Sensitivity refuse | | |

Owner: ________________  Date: ________________
