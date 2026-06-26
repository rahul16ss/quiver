# Homebrew Cask for Quiver — installs BOTH the GUI app and CLI command
# Install with: brew install --cask quiver
# Requires a homebrew-tap repository: github.com/rahul16ss/homebrew-tap
#
# Place this file at: homebrew-tap/Casks/quiver.rb
#
# After install:
#   - Quiver.app appears in /Applications (GUI)
#   - `quiver` command available in terminal (CLI)
#   - Both share the same .env, memory, and sessions
#
# The CLI uses the system Node.js (installed via `depends_on`).

cask "quiver" do
  version "1.0.0"
  sha256 "ded064c3671920d4904c30d45a4fb6a8d5a6e32b4e6ea53d6b390a681ae8d3a4"

  url "https://github.com/rahul16ss/quiver/releases/download/v#{version}/Quiver-#{version}-arm64.dmg"
  name "Quiver"
  desc "Self-evolving AI coding & research agent — CLI + GUI"
  homepage "https://github.com/rahul16ss/quiver"

  depends_on formula: "node"

  # Install the app to /Applications
  app "Quiver.app"

  # Post-install: create a CLI wrapper script in the user's PATH
  # Uses system `node` with tsx loader to run the bundled TypeScript CLI
  postflight do
    resources = "#{appdir}/Quiver.app/Contents/Resources"
    cli_wrapper = <<~SCRIPT
      #!/bin/bash
      # Quiver CLI wrapper — installed by Homebrew Cask
      # Runs the bundled CLI using system Node.js + tsx loader
      export APP_ROOT="#{resources}"
      exec node --import tsx "#{resources}/src/cli.ts" "$@"
    SCRIPT

    File.write("#{HOMEBREW_PREFIX}/bin/quiver", cli_wrapper)
    FileUtils.chmod(0755, "#{HOMEBREW_PREFIX}/bin/quiver")
  end

  # Remove the CLI wrapper on uninstall
  uninstall_postflight do
    FileUtils.rm_f("#{HOMEBREW_PREFIX}/bin/quiver")
  end

  zap trash: [
    "~/Library/Application Support/Quiver",
    "~/Library/Preferences/com.quiver.app.plist",
    "~/Library/Saved Application State/com.quiver.app.savedState",
    "~/QuiverData",
  ]
end
