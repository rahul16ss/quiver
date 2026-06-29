# Quiver Release

## Distribution Channels

### Homebrew (macOS)
```bash
brew tap rahul16ss/quiver
brew install quiver
```

Formula: `Formula/quiver.rb`

### npm
```bash
npm install -g quiver-agent
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
3. Run acceptance contract: `npm test` (must be 118/118 green — asserts the SPEC + WIRE-* integration)
4. TypeScript compilation check: `npx tsc --noEmit`
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