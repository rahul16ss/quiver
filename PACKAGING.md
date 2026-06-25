# Packaging Quiver for Distribution

This guide outlines the steps to package and distribute Quiver to other users via **NPM/Yarn** and **Homebrew**.

---

## 📦 Publishing to NPM / Yarn

By publishing to the global NPM registry, anyone can install Quiver with a single command.

### 1. Log In to NPM
Run this in your terminal and follow the prompt to log in to your NPM developer account:
```bash
npm login
```

### 2. Verify package.json Settings
Ensure the `"bin"` mapping and configuration look correct:
```json
"bin": {
  "quiver": "./bin/quiver.js"
}
```

### 3. Publish the Package
Publish the package to the public registry:
```bash
npm publish --access public
```

Once published, anyone can install and run Quiver:
```bash
npm install -g quiver-agent
quiver
```

---

## 🍺 Distributing via Homebrew (for macOS/Linux)

To distribute Quiver via the `brew install` installer, you can create a custom Homebrew Tap.

### 1. Create a Tap Repository
1. Log in to GitHub and create a new public repository named `homebrew-tap` (e.g. `github.com/yourusername/homebrew-tap`).
2. Clone the repository locally.

### 2. Add the Formula
Copy the formula file from [Formula/quiver.rb](file:///Users/rahul/quiver/Formula/quiver.rb) into your tap repository under a `Formula/` directory:
```bash
mkdir -p homebrew-tap/Formula
cp Formula/quiver.rb homebrew-tap/Formula/quiver.rb
```

### 3. Update the Tarball Checksum
When you release a new version of Quiver on GitHub (e.g. tag `v1.0.0`):
1. Download the release source code tarball:
   ```bash
   curl -LO https://github.com/rahul16ss/quiver/archive/refs/tags/v1.0.0.tar.gz
   ```
2. Calculate its SHA256 checksum:
   ```bash
   shasum -a 256 v1.0.0.tar.gz
   ```
3. Open `homebrew-tap/Formula/quiver.rb` and update:
   * `url` to point to the GitHub release archive.
   * `sha256` to the calculated checksum.

### 4. Push to GitHub
Commit and push the formula changes to your tap repository:
```bash
git add .
git commit -m "Add Quiver Formula v1.0.0"
git push origin main
```

### 5. Install via Homebrew
Anyone can now tap your repository and install Quiver natively:
```bash
brew tap yourusername/tap
brew install quiver
quiver
```
