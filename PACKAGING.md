# Packaging Quiver for Distribution

Quiver has two distribution paths: **CLI** (terminal) and **GUI** (desktop app).

---

## 🖥️ CLI Distribution

### NPM
```bash
npm login
npm publish --access public
```
Users install with:
```bash
npm install -g quiver-agent
quiver
```

### Homebrew Formula (CLI)
The CLI is distributed as a Homebrew Formula — it installs Node.js + the CLI globally.

1. Create a tap repo: `github.com/rahul16ss/homebrew-tap`
2. Copy `Formula/quiver.rb` to `homebrew-tap/Formula/quiver.rb`
3. On each release, update the `url` and `sha256` in the formula
4. Users install with:
```bash
brew tap rahul16ss/tap
brew install quiver
quiver
```

---

## 🖼️ GUI Distribution

### Building the App
```bash
# Build for current platform
npm run dist:mac    # produces dist-electron/Quiver-1.0.0.dmg
npm run dist:win    # produces dist-electron/Quiver Setup 1.0.0.exe
npm run dist:linux  # produces dist-electron/Quiver-1.0.0.AppImage
```

### Homebrew Cask (macOS GUI)
The GUI is distributed as a Homebrew Cask — it installs the `.app` to `/Applications`.

1. Build the DMG: `npm run dist:mac`
2. Upload `dist-electron/Quiver-1.0.0.dmg` to a GitHub Release
3. Calculate the SHA256:
```bash
shasum -a 256 dist-electron/Quiver-1.0.0.dmg
```
4. Copy `Formula/quiver-cask.rb` to `homebrew-tap/Casks/quiver.rb`
5. Update `sha256` with the calculated checksum
6. Users install with:
```bash
brew tap rahul16ss/tap
brew install --cask quiver
```
The app appears in `/Applications/Quiver.app` and Launchpad.

### Windows
The NSIS installer (`Quiver Setup 1.0.0.exe`) can be distributed via:
- GitHub Releases (direct download)
- Winget: `winget install quiver` (requires manifest submission)
- Chocolatey: `choco install quiver` (requires nuspec + package)

### Linux
The AppImage is a single-file portable app:
```bash
chmod +x Quiver-1.0.0.AppImage
./Quiver-1.0.0.AppImage
```
Can also be distributed via:
- Snap: `snap install quiver`
- Flatpak: `flatpak install quiver`

---

## 🚀 Release Checklist

1. **Bump version** in `package.json`
2. **Build**: `npm run dist:mac` (and/or win/linux)
3. **Create GitHub Release**: tag `v1.0.0`, upload DMG/EXE/AppImage
4. **Calculate SHA256** for each artifact
5. **Update Formula** (`Formula/quiver.rb`) with new tarball URL + checksum
6. **Update Cask** (`Formula/quiver-cask.rb`) with new DMG URL + checksum
7. **Push to tap repo**: `homebrew-tap/Formula/quiver.rb` + `homebrew-tap/Casks/quiver.rb`
8. **Publish to NPM**: `npm publish`
9. **Test**: `brew install quiver && quiver --version` + `brew install --cask quiver && open /Applications/Quiver.app`

---

## 🔏 Code Signing (macOS)

Unsigned macOS apps trigger Gatekeeper warnings. To sign:

1. Enroll in [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. Get a Developer ID Application certificate
3. Add to `package.json` build config:
```json
"mac": {
  "identity": "Developer ID Application: Your Name (TEAMID)",
  "notarize": true
}
```
4. Set environment variables:
```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
```
5. Build: `npm run dist:mac` — electron-builder signs + notarizes automatically

Until signed, users can bypass Gatekeeper with:
```bash
xattr -cr /Applications/Quiver.app
```
