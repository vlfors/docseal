# @docseal/cli

The `docseal` command: seal files into a `.dseal` package that proves their integrity, who signed them (by key), and that they existed no later than a Bitcoin-confirmed time — and verify such packages.

```bash
npm install -g @docseal/cli

docseal keygen -o me.key                        # encrypted Ed25519 key (development use)
docseal pubkey me.key                           # did:key for recipients' trusted-keys.json
docseal seal contract/ -k me.key -o contract.dseal
docseal verify contract.dseal --trust trusted-keys.json
docseal upgrade contract.dseal                  # hours later: complete the Bitcoin proof
```

`verify` exits with `0` when every check passed, `1` when the package was modified or a proof is false, `2` when nothing is wrong but not everything could be confirmed (no or pending time proof, unknown signer), and `3` on usage or I/O errors; `--json` prints the machine-readable report. The passphrase is asked on the terminal or read from `DOCSEAL_PASSPHRASE`.

Documents stay local: only the package's seal digest is sent to OpenTimestamps calendars (`--no-anchor` sends nothing). DocSeal does not prove who owns a key, that a document's contents are true, or when a document was first created.

Requires Node.js ≥ 22. Apache-2.0.
