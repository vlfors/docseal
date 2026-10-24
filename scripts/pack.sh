#!/usr/bin/env bash
# Builds and packs every published package into DIR (default: dist-packages/), in
# dependency order. These tarballs are exactly what a release publishes and attests.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/dist-packages}" && cd "${1:-$ROOT/dist-packages}" && pwd)
PACKAGES=(packages/core packages/sig-ed25519 packages/anchor-ots apps/cli apps/mcp)

pnpm --dir "$ROOT" -r build > /dev/null
for package in "${PACKAGES[@]}"; do
  (cd "$ROOT/$package" && pnpm pack --pack-destination "$OUT" > /dev/null)
done

# The CLI and the MCP server are installed globally, where no lockfile of ours applies: their
# tarballs carry an npm-shrinkwrap.json, so every install gets the dependency tree the smoke
# test installed. The DocSeal packages are bundled into them, so devDependencies leave the
# manifest, with the scripts that only make sense in this repository.
for app in cli mcp; do
  TARBALL=$(ls "$OUT"/docseal-$app-*.tgz)
  WORK=$(mktemp -d)
  tar -xzf "$TARBALL" -C "$WORK"
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    delete manifest.devDependencies;
    delete manifest.scripts;
    manifest.files.push("npm-shrinkwrap.json");
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  ' "$WORK/package/package.json"
  (cd "$WORK/package" &&
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund > /dev/null &&
    mv package-lock.json npm-shrinkwrap.json &&
    npm pack --ignore-scripts --pack-destination "$WORK" > /dev/null 2>&1)
  mv "$WORK"/docseal-$app-*.tgz "$TARBALL"
  rm -rf "$WORK"
done
ls "$OUT"/*.tgz
