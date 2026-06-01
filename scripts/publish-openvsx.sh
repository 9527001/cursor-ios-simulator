#!/usr/bin/env bash
# Package and optionally publish to Open VSX.
#
# Usage:
#   ./scripts/publish-openvsx.sh           # build .vsix only
#   ./scripts/publish-openvsx.sh --publish # publish (requires OVSX_PAT)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

echo "→ npm install"
npm install

echo "→ compile TypeScript"
npm run compile

echo "→ compile native helpers"
npm run compile-helpers

echo "→ package VSIX"
rm -rf dist
mkdir -p dist
npx --yes @vscode/vsce@latest package --out "dist/cursor-ios-simulator.vsix"

VSIX="dist/cursor-ios-simulator.vsix"
echo "✓ Built ${VSIX}"

if [[ "${1:-}" == "--publish" ]]; then
  if [[ -z "${OVSX_PAT:-}" ]]; then
    echo "❌ Set OVSX_PAT before publishing."
    echo "   Get a token: https://open-vsx.org/user-settings/tokens"
    exit 1
  fi
  echo "→ publish to Open VSX"
  npx --yes ovsx@latest publish "${VSIX}" -p "${OVSX_PAT}"
  echo "✓ Published ${VSIX}"
else
  echo ""
  echo "Install locally in Cursor:"
  echo "  Extensions → … → Install from VSIX… → ${VSIX}"
  echo ""
  echo "Publish to Open VSX:"
  echo "  OVSX_PAT=<token> ./scripts/publish-openvsx.sh --publish"
fi
