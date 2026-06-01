#!/usr/bin/env bash
# Compile headless simulator helpers (adapted from codex-plusplus-ios-simulator).
# Usage: ./scripts/compile-helpers.sh [OUT_DIR]
# Default OUT_DIR: ~/Library/Caches/co.cursor.ios-simulator
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${ROOT}/src/helpers"

if [[ "${1:-}" == "" ]]; then
  OUT_DIR="${HOME}/Library/Caches/co.cursor.ios-simulator"
elif [[ "${1}" == /* ]]; then
  OUT_DIR="${1}"
else
  OUT_DIR="${ROOT}/${1}"
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ iOS Simulator helpers require macOS + Xcode."
  exit 1
fi

mkdir -p "${OUT_DIR}"

echo "→ Compiling sim-capture → ${OUT_DIR}/sim-capture"
swiftc -O -F /Library/Developer/PrivateFrameworks \
  -framework CoreImage -framework Foundation -framework IOSurface \
  "${SRC_DIR}/sim-capture.swift" -o "${OUT_DIR}/sim-capture"

echo "→ Compiling sim-input → ${OUT_DIR}/sim-input"
clang -fobjc-arc -O2 -framework Foundation -framework CoreGraphics \
  "${SRC_DIR}/sim-input.m" -o "${OUT_DIR}/sim-input"

echo "✓ Helpers ready in ${OUT_DIR}"
