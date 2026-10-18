#!/usr/bin/env bash
# seal → verify → mutate → invalid, with the docseal CLI and no network.
#   DOCSEAL="node apps/cli/dist/index.js" examples/demo.sh     (from a checkout, after pnpm build)
#   examples/demo.sh                                          (with docseal installed)
set -euo pipefail

DOCSEAL=${DOCSEAL:-docseal}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export DOCSEAL_PASSPHRASE="demo passphrase"
run() { echo "\$ docseal $*"; $DOCSEAL "$@"; }

mkdir -p "$WORK/contract/annex"
echo "Supply agreement 17/2026: 1000 bolts at 0.10 EUR" > "$WORK/contract/agreement.txt"
echo "item,price" > "$WORK/contract/annex/prices.csv"

echo "== 1. A key, and a trusted-keys file that pins it"
run keygen -o "$WORK/me.key" > /dev/null
did=$($DOCSEAL pubkey "$WORK/me.key")
printf '{"type":"docseal-trusted-keys","version":1,"keys":[{"id":"%s","label":"Demo signer"}]}\n' "$did" > "$WORK/trusted-keys.json"
echo "$did"

echo "== 2. Seal the folder (no time proof: --no-anchor keeps the demo offline)"
run seal "$WORK/contract" -k "$WORK/me.key" -o "$WORK/contract.dseal" --title "Supply agreement" --no-anchor

echo "== 3. Verify: integrity, signature, and trust pass; time is missing"
status=0
run verify "$WORK/contract.dseal" --trust "$WORK/trusted-keys.json" --offline || status=$?
[ "$status" -eq 2 ] || { echo "expected exit code 2 (indeterminate), got $status"; exit 1; }

echo "== 4. Change one word of the agreement inside the package"
node "$HERE/tamper.mjs" "$WORK/contract.dseal" "$WORK/tampered.dseal" agreement.txt "Supply agreement 17/2026: 1000 bolts at 0.01 EUR"

echo "== 5. Verify again: invalid"
status=0
run verify "$WORK/tampered.dseal" --trust "$WORK/trusted-keys.json" --offline || status=$?
[ "$status" -eq 1 ] || { echo "expected exit code 1 (invalid), got $status"; exit 1; }

echo "== Done: the change was detected."
