#!/usr/bin/env bash
# Installs the packed tarballs with npm into an empty project, as a user would, and runs
# the examples against them: the library example and the CLI demo. Then installs the CLI's
# and the MCP server's tarballs each alone, as from a release URL, and has each verify a package.
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

echo "== CLI, installed alone"
mkdir "$WORK/cli" && cd "$WORK/cli"
npm init -y > /dev/null
npm install --no-audit --no-fund --silent "$WORK"/packages/docseal-cli-*.tgz
others=$(ls node_modules/@docseal | grep -vx cli || true)
if [ -n "$others" ]; then
  echo "the CLI pulled in @docseal packages from npm: $others"; exit 1
fi
status=0
"$WORK/cli/node_modules/.bin/docseal" verify --offline "$ROOT/spec/vectors/packages/tampered-content.dseal" > verify.log || status=$?
head -1 verify.log
[ "$status" = 1 ] || { echo "docseal verify exited with $status, not 1 (invalid)"; exit 1; }

echo "== MCP server, installed alone"
mkdir "$WORK/mcp" && cd "$WORK/mcp"
npm init -y > /dev/null
npm install --no-audit --no-fund --silent "$WORK"/packages/docseal-mcp-*.tgz
others=$(ls node_modules/@docseal | grep -vx mcp || true)
if [ -n "$others" ]; then
  echo "the MCP server pulled in @docseal packages from npm: $others"; exit 1
fi
"$WORK/mcp/node_modules/.bin/docseal-mcp" --version
node "$ROOT/scripts/mcp-smoke.mjs" "$WORK/mcp/node_modules/.bin/docseal-mcp" "$ROOT/spec/vectors/packages"
