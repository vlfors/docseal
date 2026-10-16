# Test fixtures

- `*.txt`, `*.txt.ots` — example files and proofs from the
  [OpenTimestamps client](https://github.com/opentimestamps/opentimestamps-client/tree/master/examples)
  (LGPL-3.0), used unchanged as test data. `hello-world.txt.ots` is a real proof confirmed in
  Bitcoin block 358391; `bad-stamp.txt.ots` is well-formed but does not match that block.
- `bitcoin-358391.json` — header of Bitcoin block 358391, recorded from the mempool.space API
  on 2026-10-16. Its double SHA-256 equals the block hash, so tests run without network access.
