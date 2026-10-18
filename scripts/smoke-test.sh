#!/usr/bin/env bash
# Installs the packed tarballs with npm into an empty project, as a user would, and runs
# the examples against them: the library example and the CLI demo.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

"$ROOT/scripts/pack.sh" "$WORK/packages" > /dev/null
cd "$WORK"
npm init -y > /dev/null
npm install --no-audit --no-fund --silent "$WORK"/packages/*.tgz
cp "$ROOT"/examples/*.mjs "$ROOT"/examples/demo.sh "$WORK"

echo "== library example"
node library.mjs
echo "== CLI demo"
DOCSEAL="$WORK/node_modules/.bin/docseal" ./demo.sh > demo.log || { cat demo.log; exit 1; }
tail -1 demo.log
"$WORK/node_modules/.bin/docseal" --version
