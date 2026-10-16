# `.dseal` Format v0.1 — Draft

Status: design draft. The format must not be considered stable until the JSON Schemas and test vectors are published.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119.

## Conventions

| Item | Rule |
|---|---|
| `H(x)` | SHA-256 of `x`, 32 raw bytes |
| `JCS(x)` | RFC 8785 canonical JSON serialization of `x`, as UTF-8 bytes |
| `‖` | byte concatenation |
| `UTF8("…\0")` | the ASCII string followed by a single `0x00` byte |
| Hashes in JSON | lowercase hex, 64 characters |
| Salts in JSON | lowercase hex, 32 characters (16 bytes) |
| Other binary data in JSON (signatures, proofs) | base64url without padding (RFC 4648 §5) |
| Timestamps | RFC 3339 in UTC with a `Z` suffix, e.g. `2026-10-16T00:00:00Z` |
| Integers | JSON integers in `0 … 2^53 − 1` |

All JSON documents MUST be I-JSON (RFC 7493). A parser MUST reject duplicate object keys, invalid UTF-8, and lone surrogates. Hashes over JSON documents are always computed over `JCS` of the parsed value, never over the raw file bytes.

### Derived values

```text
manifestHash      = H(JCS(manifest))
statementHash     = H(JCS(statement))
envelopeDigest_i  = H(JCS(envelope_i))
```

## Container

`.dseal` is a ZIP container. `mimetype` MUST be the first entry, stored without compression, and contain exactly `application/vnd.docseal+zip` with no trailing newline.

```text
package.dseal
├── mimetype
├── manifest.json
├── statement.json
├── files/
│   └── <manifest path>
├── signatures/
│   └── 0001.json
└── anchors/
    └── seal-1.json
```

Each file listed in the manifest is stored at `files/<path>`. Signature envelopes are stored at `signatures/NNNN.json` (four or more decimal digits). Anchor files are stored at `anchors/seal-N.json`.

### Parser requirements

- Limits on entry count, per-entry and total uncompressed size, and compression ratio. Defaults are configurable and the effective limits are included in the report:

  | Limit | Default |
  |---|---|
  | Entries | 10 100 |
  | Uncompressed size of one document | 4 GiB |
  | Uncompressed size of all documents | 16 GiB |
  | Uncompressed size of one JSON entry | 16 MiB |
  | Compression ratio of one entry | 1000 : 1 |

  Sizes are enforced while streaming, not trusted from ZIP headers.
- Absolute paths, `..` and `.` segments, empty segments, backslashes, NUL and other C0 control characters, symlinks, and device entries MUST be rejected.
- Duplicate entries and collisions after normalization (see [Paths](#paths)) MUST be rejected.
- **Any entry not defined by this specification MUST be rejected in v0.1** (`format: invalid`). This includes directory entries other than `files/`, `signatures/`, `anchors/` and their subdirectories under `files/`.
- Contents are never executed and never loaded as plugins.
- Encrypted ZIP entries and ZIP64 multi-disk archives are rejected. ZIP64 single-disk archives are supported.

## Paths

A manifest `path`:

- is converted to Unicode NFC;
- uses `/` as the separator, with no leading or trailing `/`;
- has no empty, `.`, or `..` segments;
- contains no NUL, C0 control characters, or `\`;
- is at most 1024 UTF-8 bytes.

After normalization, paths MUST be unique, and also unique when compared after `toLowerCase()` (locale-independent Unicode lowercase) to prevent collisions on case-insensitive file systems. Paths are sorted by their UTF-8 bytes.

A manifest whose `path` values are not already in normalized form is invalid; normalization happens when sealing, not when verifying.

## `manifest.json`

Holds the full package composition and user metadata:

```json
{
  "type": "docseal-manifest",
  "version": 1,
  "packageId": "urn:uuid:3b0c4f8e-6a1d-4c2b-9f57-0d1e2a3b4c5d",
  "hashAlgorithm": "sha-256",
  "merkleScheme": "docseal-v1",
  "files": [
    {
      "path": "document.pdf",
      "size": 12345,
      "mediaType": "application/pdf",
      "hash": "<64 hex>",
      "salt": "<32 hex>"
    }
  ],
  "metadata": {
    "title": "Example package",
    "custom": {}
  },
  "generator": "docseal-cli/0.1.0"
}
```

- `files` MUST contain at least one entry and MUST be sorted by path as defined above.
- `mediaType` is informational. It is covered by `manifestHash` but is not part of the Merkle leaf.
- `metadata` and `generator` are optional. Metadata is never sent to a public network.

## Merkle tree `docseal-v1`

```text
leaf_i = H(0x00 ‖ JCS({ "path": path_i, "size": size_i, "hash": hash_i, "salt": salt_i }))
node   = H(0x01 ‖ left ‖ right)
```

`hash_i` and `salt_i` are the lowercase hex strings exactly as they appear in the manifest.

The tree over the sorted leaves `D[0..n)`, `n ≥ 1`, is defined as in RFC 6962 §2.1:

```text
MTH(D[0..1)) = leaf_0
MTH(D[0..n)) = H(0x01 ‖ MTH(D[0..k)) ‖ MTH(D[k..n)))   where k is the largest power of two < n
```

This is equivalent to pairing level by level and promoting an unpaired node without duplicating it. `merkleRoot` is `MTH` of all leaves, encoded as lowercase hex.

### Salt

Every file has a `salt` of 16 bytes from a cryptographically secure random generator, generated anew for each sealing. The salt prevents an observer who sees a leaf hash, for example in a selective-disclosure proof, from confirming a guess about a short, predictable document. See [THREAT_MODEL.md](../THREAT_MODEL.md#per-file-salt).

## `statement.json`

The minimal signable statement:

```json
{
  "type": "docseal-package-statement",
  "version": 1,
  "packageId": "urn:uuid:3b0c4f8e-6a1d-4c2b-9f57-0d1e2a3b4c5d",
  "hashAlgorithm": "sha-256",
  "merkleScheme": "docseal-v1",
  "merkleRoot": "<64 hex>",
  "manifestHash": "<64 hex>",
  "createdAt": "2026-10-16T00:00:00Z",
  "previous": null,
  "signaturePolicy": {
    "type": "any-valid"
  },
  "critical": []
}
```

- `packageId`, `hashAlgorithm`, and `merkleScheme` MUST equal the corresponding manifest fields.
- `createdAt` is a claimed time, not a proven one.
- `previous` MUST be `null` in v0.1.
- `signaturePolicy.type` MUST be `any-valid` in v0.1: at least one valid signature is required.
- Including `merkleRoot` directly allows a single disclosed file to be verified in the future without transferring the full manifest.

## Critical extensions

`statement.json` and the signature envelope's `protected` object carry a `critical` array of extension identifiers. A verifier that does not understand every listed identifier MUST return `unsupported` for the affected axis instead of continuing. v0.1 defines no extensions, so a v0.1 verifier returns `unsupported` for any non-empty `critical`.

Unknown fields that are not listed in `critical` MAY be ignored. They remain covered by the relevant hash.

## Signature envelope

```json
{
  "protected": {
    "type": "docseal-signature",
    "version": 1,
    "suite": "ed25519",
    "profile": "docseal-ed25519-v1",
    "signer": "did:key:z6Mk...",
    "role": "author",
    "claimedAt": "2026-10-16T00:01:00Z",
    "statementHash": "<64 hex>",
    "attributes": {
      "purpose": "approve"
    },
    "critical": []
  },
  "value": "<base64url>"
}
```

Signed bytes:

```text
UTF8("DocSeal/v1/signature\0") ‖ H(JCS(protected))
```

All fields that affect the meaning of the signature are inside `protected`.

### Profile `docseal-ed25519-v1`

- `signer` is a `did:key` with the Ed25519 public-key multicodec (`0xed`), multibase base58btc (`z…`).
- The signature is pure Ed25519 (RFC 8032, not Ed25519ph) over the signed bytes above. `value` is the 64-byte signature in base64url.
- Verification uses the strict rules of `@noble/curves` (canonical `S`, rejection of small-order public keys).

A package MUST contain at least one envelope. Two envelopes with the same `envelopeDigest` are invalid.

## Seal and anchor receipt

The seal binds the statement and the set of signature envelopes:

```text
signaturesSetHash = H(UTF8("DocSeal/v1/signature-set\0") ‖ d_1 ‖ … ‖ d_n)
seal              = H(UTF8("DocSeal/v1/anchor\0") ‖ statementHash ‖ signaturesSetHash)
```

`d_1 … d_n` are the raw 32-byte `envelopeDigest` values of all envelopes in the package, sorted in ascending byte order. The order does not depend on ZIP file names.

`anchors/seal-1.json`:

```json
{
  "type": "docseal-anchor",
  "version": 1,
  "seal": "<64 hex>",
  "statementHash": "<64 hex>",
  "envelopes": ["<64 hex>", "<64 hex>"],
  "receipts": [
    {
      "provider": "opentimestamps",
      "network": "bip122:000000000019d6689c085ae165831e93",
      "digestAlgorithm": "sha-256",
      "digest": "<64 hex>",
      "proof": "<base64url of the .ots file>",
      "cached": {
        "status": "confirmed",
        "submittedAt": "2026-10-16T00:02:00Z",
        "blockHeight": 915432
      }
    }
  ]
}
```

- `envelopes` lists the envelope digests in sorted order. The verifier recomputes `seal` from the envelopes present in the package and MUST report `time: invalid` if the recomputed seal or the envelope set differs.
- `receipt.digest` MUST equal `seal`.
- v0.1 packages have at most one anchor file, `anchors/seal-1.json`. A package without an anchor yields `time: missing`.
- Everything under `cached` is an untrusted hint. Status, time, and block height are always derived from the proof and a `ChainReader`.

### OpenTimestamps

- `proof` is the binary `.ots` detached timestamp file for `seal`.
- A Bitcoin attestation is accepted as `confirmed` when its block has at least **6 confirmations** by default (configurable). Fewer confirmations, or only calendar (pending) attestations, yield `time: pending`.
- The attested time is the block header `time` of the attested block. It is accurate only to within about two hours.
- The report records which `ChainReader` source was used (own node, explorer URL, or several).

## Verdicts

A report must not collapse everything into one ambiguous word. Axes:

```text
format:       valid | invalid | unsupported
integrity:    valid | invalid | not-checked
signature:    valid | invalid | unsupported | missing
trust:        trusted | untrusted | unknown | not-evaluated
time:         confirmed | pending | invalid | unsupported | missing
completeness: full | partial | incomplete
overall:      valid | invalid | indeterminate
```

- `completeness` is `full` when every manifest file was hashed and every signature and anchor was evaluated; `partial` when only some files were checked by design (future selective disclosure); `incomplete` when a check could not run (missing file, unsupported suite, unreachable `ChainReader`).
- `overall: valid` only when `format: valid`, `integrity: valid`, `signature: valid` (policy satisfied), `trust: trusted`, `time: confirmed`, and `completeness: full`.
- `overall: invalid` when any axis is `invalid`.
- `overall: indeterminate` otherwise, for example pending time or an untrusted signer.

For integrity, the report distinguishes missing, modified, and extra files per path.

## Local key file (development only)

```json
{
  "type": "docseal-key",
  "version": 1,
  "suite": "ed25519",
  "publicKey": "did:key:z6Mk...",
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<32 hex>" },
  "cipher": { "name": "xchacha20-poly1305", "nonce": "<48 hex>" },
  "ciphertext": "<base64url of the 32-byte Ed25519 seed + tag>"
}
```

The key is derived with scrypt (`@noble/hashes`) and encrypted with XChaCha20-Poly1305 (`@noble/ciphers`). JCS of the object without `ciphertext` is used as associated data. The CLI warns that this format is for development and that production keys belong in an HSM, KMS, or hardware token.

## Crypto agility

v0.1 is effectively fixed to SHA-256 and the `docseal-ed25519-v1` profile. Algorithm identifiers are kept in the data, but changing an algorithm happens through a new profile or specification version with its own test vectors, not through an arbitrary string.

## Test vectors

Published in `spec/vectors/` before the format is declared stable:

- Merkle roots for 1, 2, 3, 4, 5, and 7 leaves;
- Unicode paths (NFC/NFD, case collisions) with expected accept/reject results;
- signed bytes and signatures for a fixed Ed25519 seed;
- `signaturesSetHash` and `seal` for one and two envelopes;
- negative vectors for every rule marked MUST above.
