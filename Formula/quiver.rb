# Homebrew Formula for Quiver
#
# To install via Homebrew:
#   brew tap rahul16ss/quiver
#   brew install quiver
#
# Or directly from the formula file:
#   brew install ./Formula/quiver.rb
#
# This formula installs the Quiver CLI agent harness globally.

class Quiver < Formula
  desc "Open foundation for controlled, source-backed document workflows in finance"
  homepage "https://github.com/rahul16ss/quiver"
  # Release archive pinned to the v1.0.0 source commit.
  url "https://github.com/rahul16ss/quiver/archive/v1.0.0.tar.gz"
  sha256 "6fa3ff1380f0735562c35a984bb417e1cbe46edcd5e20625313ac0ba24717add"
  license "Apache-2.0"
  head "https://github.com/rahul16ss/quiver.git", branch: "main"

  # Quiver is a Node.js/TypeScript application
  depends_on "node@20"

  def install
    # Install npm dependencies
    system "npm", "install", *std_npm_args(prefix: false)

    # Install the CLI binary globally
    system "npm", "install", "-g", *std_npm_args

    # Install the bin symlink
    bin.install_symlink libexec/"bin/quiver.js" => "quiver"
  end

  test do
    # Verify quiver is installed and responds to --version
    assert_match "1.0.0", shell_output("#{bin}/quiver --version")
  end
end
