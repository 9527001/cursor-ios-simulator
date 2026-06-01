#!/usr/bin/env bash
# One-shot setup for standalone development.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

echo "→ npm install"
npm install

echo "→ TypeScript compile"
npm run compile

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "→ Native helpers → bin/"
  bash scripts/compile-helpers.sh bin
else
  echo "⚠ Skipping native helpers (macOS only). Install on Mac before packaging."
fi

echo ""
echo "✓ Setup complete."
echo ""
echo "Next:"
echo "  F5            Run Extension in Cursor/VS Code"
echo "  npm run install:local   Build VSIX and install into Cursor"
