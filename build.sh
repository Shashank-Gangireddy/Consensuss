#!/bin/bash
# Builds the Chrome Web Store upload package from manifest.json's current version.
# Usage: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="consensus-extension-${VERSION}.zip"

if [ -f "$OUT" ]; then
  echo "error: $OUT already exists — bump the version in manifest.json first" >&2
  exit 1
fi

rm -f consensus-extension.zip consensus-extension-*.zip

zip -r "$OUT" . \
  -x "design-mockup/*" \
  -x ".git/*" \
  -x ".gitignore" \
  -x "*.DS_Store" \
  -x "*/.DS_Store" \
  -x "*.zip" \
  -x "build.sh" \
  -x "README.md" \
  -x "CHANGELOG.md"

echo ""
echo "Built $OUT"
echo ""
echo "Before uploading, confirm:"
echo "  [ ] Version in manifest.json bumped from the last published version"
echo "  [ ] CHANGELOG.md has an entry for this version"
echo "  [ ] guidance-seed.json refreshed if you want new installs to get updated rules"
echo "  [ ] host_permissions / content_security_policy unchanged (or, if changed, expect manual review)"
