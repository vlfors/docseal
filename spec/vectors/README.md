# Test vectors

Language-neutral vectors for the DocSeal v0.1 format. An implementation is conforming only if it reproduces all of them. The TypeScript implementation regenerates and compares them in `tests/vectors.test.ts`; the independent Python verifier in `verifiers/python/` checks them from the specification.

| File | Content |
|---|---|
| `jcs.json` | RFC 8785 canonicalization, including ECMAScript number formatting and UTF-16 key order |
| `paths.json` | valid and invalid paths, UTF-8 sort order, case and file/directory collisions |
| `merkle.json` | leaf hashes and roots for 1–8 leaves, Unicode paths, an empty file |
| `signature.json` | signed bytes for a fixed protected header and the RFC 8032 test key; must-accept and must-reject signatures, including non-canonical encodings and all small-order public keys |
| `seal.json` | manifest and statement hashes, envelope digests, `signaturesSetHash`, and the seal for two signatures |
| `packages/` | 25 golden `.dseal` packages and `expected.json` with the required verdicts |

Golden packages are verified offline: no trust policy, only the `ed25519` suite and the `opentimestamps` provider registered, no chain source. A package's verdicts must equal `expected` exactly.

Regenerate after an intentional format change (and review the diff):

```bash
UPDATE_VECTORS=1 pnpm vitest run tests/vectors.test.ts
```
