# @docseal/core

The core of [DocSeal](https://www.npmjs.com/package/@docseal/cli): the `.dseal` package format v0.1, streaming hashing and container I/O, the Merkle tree, the verification pipeline, and the plugin interfaces. It knows no concrete signature algorithm, key store, trust rule, or blockchain: those are plugins the application registers.

```bash
npm install @docseal/core @docseal/sig-ed25519
```

```js
import { DocSeal, pinnedKeys, utf8 } from "@docseal/core";
import { ed25519Suite, generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";

const signer = memoryKeyProvider(generateSecretKey());
const docseal = new DocSeal({
  signatures: [ed25519Suite()],
  trust: pinnedKeys([{ id: await signer.getSigner(), label: "Example signer" }]),
});

const { container } = await docseal.seal({
  files: [{ path: "contract.txt", data: utf8("Supply agreement 17/2026") }],
  signer,
});
const report = await docseal.verify(container);
console.log(report.overall, report.axes);
```

The report gives a separate verdict for each axis — format, integrity, signature, trust, time, completeness — and an overall `valid`, `invalid`, or `indeterminate`. Add `@docseal/anchor-ots` for a time proof through OpenTimestamps.

Large packages never have to fit in memory: `sealTo`, `verify`, and `upgradeTo` accept a `ByteSource` and write to a `ByteSink` (`blobSource` covers browser files).

Requires Node.js ≥ 22 or a current browser. Apache-2.0.
