# Quiver Release

## Distribution Channels

> Buyer path: engagement-led install or a signed installer once production
> signing keys exist (SPEC §19). Homebrew and `npm install -g` are developer
> convenience. Interactive surface: loopback browser UI via the harness daemon.

### Homebrew (macOS) — developer convenience

```bash
brew tap rahul16ss/quiver
brew install quiver
```

Formula: `Formula/quiver.rb` — **automatically repinned on every release tag** by the `update-homebrew-formula` job in `.github/workflows/release.yml` (runs `scripts/update_formula.js` to update the url, sha256, and version, then commits and pushes). To update manually: `npm run update-formula [tag]`.

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
npm start   # loopback browser UI via harness daemon
```

## Versioning

Quiver uses semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR:** Breaking changes to session schema or config
- **MINOR:** New features, backward-compatible
- **PATCH:** Bug fixes, security patches

## Release Checklist

1. Update version in `package.json`
2. Update session schema version if needed (`src/session/schema.ts`)
3. Run acceptance contract: `npm test` (spec + harness gates)
4. TypeScript compilation check: `npx tsc --noEmit`
5. Run the three reference demos: `demo:ic-memo`, `demo:post-earnings`, `demo:portfolio-review`
6. Daemon smoke: `npx tsx scripts/daemon_smoke.ts`
7. Update `docs/` and `NOTES/STATUS.md` if architecture changed
8. Create GitHub release / update Homebrew formula as appropriate
9. Verify `quiver --version` works after install
10. Visual browser-UI walkthrough with screenshots actually read

## Uninstall

```bash
# Homebrew
brew uninstall quiver

# npm
npm uninstall -g quiver-agent
```

Uninstalling removes binaries but does not touch user data or configuration under `~/.quiver/`.

## Browser UI (experience plane)

Served from `src/harness/ui/` by `HarnessDaemon` / `QuiverDaemon` on loopback.
See `NOTES/STATUS.md` for open release items.
