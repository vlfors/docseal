// Seal two documents with a new Ed25519 key and verify the package, offline.
//   node examples/library.mjs
import { DocSeal, pinnedKeys, utf8 } from "@docseal/core";
import { ed25519Suite, generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";

const signer = memoryKeyProvider(generateSecretKey());
const docseal = new DocSeal({
  signatures: [ed25519Suite()],
  trust: pinnedKeys([{ id: await signer.getSigner(), label: "Example signer" }]),
});

const { container } = await docseal.seal({
  files: [
    { path: "contract.txt", data: utf8("Supply agreement 17/2026") },
    { path: "annex/prices.csv", data: utf8("item,price\nbolt,0.10\n") },
  ],
  signer,
  metadata: { title: "Supply agreement" },
});

const report = await docseal.verify(container);
console.log(report.overall, report.axes);
// "indeterminate": everything checks out, but there is no time proof (no anchor provider
// was registered), so the time axis is "missing".
if (report.axes.integrity !== "valid" || report.axes.signature !== "valid" || report.axes.trust !== "trusted") {
  process.exit(1);
}
