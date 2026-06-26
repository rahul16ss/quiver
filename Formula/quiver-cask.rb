# Homebrew Cask for Quiver GUI (Electron app)
# Install with: brew install --cask quiver
# Requires a homebrew-tap repository: github.com/rahul16ss/homebrew-tap
#
# Place this file at: homebrew-tap/Casks/quiver.rb

cask "quiver" do
  version "1.0.0"
  sha256 "REPLACE_WITH_DMG_SHA256"

  url "https://github.com/rahul16ss/quiver/releases/download/v#{version}/Quiver-#{version}.dmg"
  name "Quiver"
  desc "Self-evolving AI coding & research agent — GUI"
  homepage "https://github.com/rahul16ss/quiver"

  app "Quiver.app"

  zap trash: [
    "~/Library/Application Support/Quiver",
    "~/Library/Preferences/com.quiver.app.plist",
    "~/Library/Saved Application State/com.quiver.app.savedState",
  ]
end
