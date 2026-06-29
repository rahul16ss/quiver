#!/usr/bin/env bash
#
# Quiver release script — creates a git tag and pushes it to trigger
# the GitHub Actions release workflow.
#
# Usage:
#   ./scripts/release.sh              # uses version from package.json
#   ./scripts/release.sh 1.1.0        # explicit version
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Determine version
if [ -n "${1:-}" ]; then
  VERSION="$1"
  # Update package.json
  node -e "
    const pkg = require('./package.json');
    pkg.version = '${VERSION}';
    require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  git add package.json
  git commit -m "chore: bump version to v${VERSION}"
else
  VERSION=$(node -p "require('./package.json').version")
fi

TAG="v${VERSION}"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "⚠️  Tag ${TAG} already exists."
  echo "   To re-release, delete it first: git tag -d ${TAG} && git push origin :refs/tags/${TAG}"
  exit 1
fi

# Create and push tag
git tag "$TAG"
git push origin "$TAG"

echo ""
echo "✅ Tagged ${TAG} and pushed to GitHub."
echo "   The release workflow will create the GitHub release automatically."
echo "   https://github.com/rahul16ss/quiver/actions"