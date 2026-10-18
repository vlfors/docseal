# @docseal/sig-ed25519

Ed25519 signatures for [DocSeal](https://www.npmjs.com/package/@docseal/core) packages.

- `ed25519Suite()`: the `SignatureSuite` for profile `docseal-ed25519-v1`. Verification is strict: canonical encodings only, `S < L`, and the public key and `R` in the prime-order subgroup, so every conforming verifier reaches the same answer.
- `memoryKeyProvider(secretKey)`: a `KeyProvider` for a key held in memory; `generateSecretKey()` makes one.
- Signers are identified by `did:key` (`publicKeyToDid`, `didToPublicKey`).
- `createKeyFile` / `openKeyFile`: a passphrase-encrypted key file (scrypt and XChaCha20-Poly1305) **for development use**. For real keys, implement `KeyProvider` against a hardware token or a key management service.

```js
import { DocSeal } from "@docseal/core";
import { ed25519Suite } from "@docseal/sig-ed25519";

const docseal = new DocSeal({ signatures: [ed25519Suite()] });
```

Apache-2.0.
