# Quiver Release

## Distribution Channels

> **Honest status.** The Electron build is currently **unsigned** (the
> update-manifest Ed25519 pubkey is a placeholder — see SPEC §19). Homebrew and
> `npm install -g` are developer-convenience channels; the buyer path is a
> signed installer or engagement-led install (SPEC §15). Do not ship a signed
> release until the signing key is real.

### Homebrew (macOS) — developer convenience
```bash
brew tap rahul16ss/quiver
brew install quiver
```

Formula: `Formula/quiver.rb`

### npm (global install from a clone)
```bash
git clone https://github.com/rahul16ss/quiver.git
cd quiver
npm install -g .
```

### Source
```bash
git clone https://github.com/rahul16ss/quiver.git
cd quiver
npm install
npm start   # or: npm run gui
```

## Versioning

Quiver uses semantic versioning (MAJOR.MINOR.PATCH):
- **MAJOR:** Breaking changes to session schema or config
- **MINOR:** New features, backward-compatible
- **PATCH:** Bug fixes, security patches

## Release Checklist

1. Update version in `package.json`
2. Update session schema version if needed (`src/session/schema.ts`)
3. Run acceptance contract: `npm test` (every check must pass — asserts the SPEC + WIRE-* integration; the count is whatever the gate prints)
4. TypeScript compilation check: `npx tsc --noEmit`
5. Run the flagship demo: `npm run demo:ic-memo` (all acceptance checks must pass)
6. Update `docs/` if architecture changed
7. Build/package Electron app: `npm run dist` (or `dist:mac` / `dist:win` / `dist:linux`)
8. Create GitHub release with tagged binary
9. Update Homebrew formula (`Formula/quiver.rb`)
10. Verify `quiver --version` works after install

## Uninstall

```bash
# Homebrew
brew uninstall quiver

# npm
npm uninstall -g quiver-agent
```

Uninstalling removes binaries but does not touch user data or configuration under `~/.quiver/`.

## Electron App

The desktop app is built with Electron:
- `ui/main.ts` — Main process (hardened)
- `ui/preload.js` — Preload script (context-isolated)
- `ui/renderer/` — Renderer (sandboxed)

Package: `npm run dist` (or `dist:mac` / `dist:win` / `dist:linux`)