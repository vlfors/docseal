#!/usr/bin/env bash
# Builds and packs every published package into DIR (default: dist-packages/), in
# dependency order. These tarballs are exactly what a release publishes and attests.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/dist-packages}" && cd "${1:-$ROOT/dist-packages}" && pwd)
PACKAGES=(packages/core packages/sig-ed25519 packages/anchor-ots apps/cli)

pnpm --dir "$ROOT" -r build > /dev/null
for package in "${PACKAGES[@]}"; do
  (cd "$ROOT/$package" && pnpm pack --pack-destination "$OUT" > /dev/null)
done
ls "$OUT"/*.tgz
