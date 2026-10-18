# @docseal/anchor-ots

OpenTimestamps time proofs for [DocSeal](https://www.npmjs.com/package/@docseal/core) packages: proof that a sealed package existed no later than a Bitcoin block.

- `openTimestamps(options)`: the `AnchorProvider`. Sealing submits the package's seal digest — never the documents — to public calendars; `upgrade` later fetches the completed proof; verification checks it against a Bitcoin block header and the required number of confirmations.
- `esploraChainReader(url)`: reads block headers from an Esplora API (mempool.space by default). Each header must hash to the block hash the source names for that height; the source itself is trusted for which block is at a height, so it is named in the report. Point it at your own node's Esplora for independence.
- `firstAvailableChainReader([...readers])`: tries several sources in order and skips one that fails, so one unreachable explorer does not leave the time unchecked. The report names the source that answered.
- A strict parser and serializer for the `.ots` format, with limits for hostile proofs.

```js
import { DocSeal } from "@docseal/core";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { esploraChainReader, openTimestamps } from "@docseal/anchor-ots";

const docseal = new DocSeal({
  signatures: [ed25519Suite()],
  anchors: [openTimestamps()],
  chain: esploraChainReader(),
});
```

A new proof is `pending` until a calendar commits it to Bitcoin, usually within a few hours; call `docseal.upgrade(package)` then.

Apache-2.0.
