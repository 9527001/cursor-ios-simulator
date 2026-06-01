#!/usr/bin/env bash
# Tag and trigger GitHub Release workflow.
#
# Usage:
#   ./scripts/release.sh 0.4.0
#   ./scripts/release.sh 0.4.0 --push
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

VERSION="${1:-}"
PUSH=false
if [[ "${2:-}" == "--push" ]]; then
  PUSH=true
fi

if [[ -z "${VERSION}" ]]; then
  echo "Usage: ./scripts/release.sh <version> [--push]"
  echo "Example: ./scripts/release.sh 0.4.0 --push"
  exit 1
fi

TAG="v${VERSION}"
PKG="package.json"

if [[ ! -f "${PKG}" ]]; then
  echo "❌ ${PKG} not found"
  exit 1
fi

CURRENT="$(node -p "require('./package.json').version")"
if [[ "${CURRENT}" != "${VERSION}" ]]; then
  echo "→ bump package.json ${CURRENT} → ${VERSION}"
  node - <<NODE
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('${PKG}', 'utf8'));
pkg.version = '${VERSION}';
fs.writeFileSync('${PKG}', JSON.stringify(pkg, null, 2) + '\n');
NODE
fi

echo "→ build"
npm run build
npm run package

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add package.json package-lock.json 2>/dev/null || git add package.json
  git commit -m "chore: release ${TAG}" || true
fi

if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "❌ tag ${TAG} already exists"
  exit 1
fi

git tag -a "${TAG}" -m "Release ${TAG}"
echo "✓ tagged ${TAG}"
echo "✓ VSIX: dist/cursor-ios-simulator.vsix"

if [[ "${PUSH}" == true ]]; then
  git push origin HEAD
  git push origin "${TAG}"
  echo "✓ pushed ${TAG} — GitHub Release workflow will run"
else
  echo ""
  echo "Next:"
  echo "  git push origin HEAD && git push origin ${TAG}"
fi
