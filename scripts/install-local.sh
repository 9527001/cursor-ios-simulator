#!/usr/bin/env bash
# Build VSIX and install into Cursor (or VS Code with --editor=vscode).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

EDITOR="${EDITOR:-cursor}"
VSIX="dist/cursor-ios-simulator.vsix"

bash scripts/setup.sh
npm run package

if command -v "${EDITOR}" >/dev/null 2>&1; then
  echo "→ Installing into ${EDITOR}"
  "${EDITOR}" --install-extension "${VSIX}" --force
  echo "✓ Installed. Reload Window, then Cmd+Y to open iOS Simulator panel."
else
  echo "✓ Built ${VSIX}"
  echo "Install manually: Extensions → … → Install from VSIX…"
fi
