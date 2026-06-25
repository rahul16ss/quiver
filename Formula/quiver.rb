class Quiver < Formula
  desc "Stateful, self-evolving personal AI agent helper"
  homepage "https://github.com/rahul16ss/quiver"
  url "https://github.com/rahul16ss/quiver/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "Apache-2.0"

  depends_on "node"

  def install
    # Install npm dependencies locally under libexec
    system "npm", "install", *Language::Node.local_npm_install_args
    libexec.install Dir["*"]
    # Symlink bin/quiver.js wrapper to brew bin folder as "quiver"
    bin.install_symlink libexec/"bin/quiver.js" => "quiver"
  end

  test do
    # Basic binary link sanity check
    assert_match "quiver", shell_output("#{bin}/quiver --help", 1)
  end
end
