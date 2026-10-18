# `.dseal` Format v0.1

Status: **final**, frozen with DocSeal 0.1.0. The format is cross-checked by two independent implementations (TypeScript and Python) against the published JSON Schemas and test vectors, and by differential fuzzing of both. Any change that alters the verdict for some package requires a new format version; see [Changes](#changes).

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
| Timestamps | RFC 3339 in UTC with a `Z` suffix, e.g. `2026-10-16T00:00:00Z`; see [Timestamps](#timestamps) |
| Integers | JSON integers in `0 … 2^53 − 1` |

All JSON documents MUST be I-JSON (RFC 7493). A parser MUST reject duplicate object keys, invalid UTF-8, lone surrogates, numbers that do not fit an IEEE 754 double (such as a 400-digit integer), and values nested more than 64 levels deep (the top-level value is at level 0). Numbers are read as doubles, as in ECMAScript: an integer beyond 2^53 is rounded before JCS, so every implementation hashes the same value. Fields this specification defines as integers MUST be in `0 … 2^53 − 1`. Hashes over JSON documents are always computed over `JCS` of the parsed value, never over the raw file bytes.

### Validation and verdicts of documents

Each document has a `type` and a `version`. A wrong `type`, a missing required field, or a field of the wrong form makes the document invalid. A `version` other than `1`, or a value this version does not define where the text says "MUST be … in v0.1" (`hashAlgorithm`, `merkleScheme`, `previous`, `signaturePolicy.type`, a non-empty `critical`), makes it unsupported. Fields not defined here are kept and covered by the document's hash.

Where the result lands depends on the document: a problem in `manifest.json` or `statement.json` is a `format` result for the whole package; in a signature envelope it is the result of that one signature; in an anchor file, of the `time` axis. See [Verdicts](#verdicts).

### Timestamps

A timestamp matches `YYYY-MM-DDTHH:MM:SS[.fraction]Z` with ASCII digits and MUST name a real calendar date: month `01`–`12`, day within that month (29 February only in Gregorian leap years), hour `00`–`23`, minute and second `00`–`59`. Leap seconds (`:60`) and offsets other than `Z` are rejected. Verifiers check the fields directly rather than relying on a platform date parser, so that every implementation accepts the same strings.

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

- Limits on entry count, per-entry and total uncompressed size, and compression ratio. Defaults are configurable; a verifier that changes them says so:

  | Limit | Default |
  |---|---|
  | Entries | 10 100 |
  | Uncompressed size of one document | 16 GiB |
  | Uncompressed size of all documents | 64 GiB |
  | Uncompressed size of one JSON entry | 16 MiB |
  | Compression ratio of one entry | 1000 : 1 |
  | Central directory | 64 MiB |

  Declared sizes of all entries are checked against the limits before anything is decompressed, and actual sizes are enforced while decompressing: an entry that inflates to more than its declared size is rejected. Every entry's CRC-32 MUST match its data. Documents are meant to be verified as streams: a verifier need not hold a document, or the package, in memory.
- Absolute paths, `..` and `.` segments, empty segments, backslashes, NUL and other C0 control characters, symlinks, and device entries MUST be rejected.
- Duplicate entries and collisions after normalization (see [Paths](#paths)) MUST be rejected.
- **Any entry not defined by this specification MUST be rejected in v0.1** (`format: invalid`). This includes directory entries other than `files/`, `signatures/`, `anchors/` and their subdirectories under `files/`.
- The local file header of every entry MUST agree with its central directory record: general-purpose flags, compression method, CRC-32, compressed and uncompressed sizes, and file name. Otherwise a streaming unzip tool, which reads local headers, could extract different bytes from those that were verified.
- Data descriptors (general-purpose flag bit 3) MUST be rejected: sizes and CRC-32 belong in the local header.
- Entries MUST tile the archive: the first local header starts at offset 0, each entry starts exactly where the previous one ends, and the last one ends at the start of the central directory. Overlapping entries (used by ZIP bombs that reuse one compressed stream) and gaps (where an extra local entry could be hidden) are both rejected.
- Directory entries MUST be empty.
- Extra fields MUST be well formed: a sequence of blocks, none truncated and no block ID repeated. Unknown blocks (timestamps, Unix IDs) are ignored. The Info-ZIP Unicode Path block (`0x7075`) MUST be rejected, because some tools extract the entry under the name it carries instead of the header name.
- Contents are never executed and never loaded as plugins.
- Entries are stored (method 0) or deflated (method 8); any other method is invalid in v0.1. Deflated data MUST be exactly one complete raw deflate stream (RFC 1951): a stream that never reaches its final block, and bytes after the end of the stream, are both invalid. (Some libraries accept either silently.)
- Encrypted entries and multi-disk archives are rejected: every disk number is 0, and the starting disk of every entry is 0.

### ZIP64

Single-disk ZIP64 archives are supported, and are required once a size, an offset, or the entry count does not fit the classic fields. The rules leave one reading of every value:

- A header field holding its marker (`0xFFFF` or `0xFFFFFFFF`) takes its value from the ZIP64 extra block (`0x0001`); any other value is the value itself.
- In the central directory, the ZIP64 block MUST contain exactly the fields whose header value is the marker, in the order uncompressed size, compressed size, local header offset, starting disk; no more, no fewer.
- In a local header, the two sizes are either both values, with no ZIP64 block, or both `0xFFFFFFFF` with a ZIP64 block of exactly the uncompressed and the compressed size (16 bytes). Either way they MUST equal the central directory's.
- If the ZIP64 end of central directory locator is present right before the end of central directory record, the ZIP64 end record MUST start at the offset the locator names and end exactly where the locator starts, with a record size of 44 (no extensible data). Each field of the classic end record MUST then be its marker or equal to the ZIP64 value. Without a locator, no field of the classic end record may be a marker.
- The central directory ends exactly where the ZIP64 end record starts, or, without ZIP64, where the classic end record starts.
- Values above 2^53 − 1 are rejected.

Writers SHOULD use ZIP64 fields only where a value needs them, so that small packages stay readable by older tools.

### Writing

This part is informative. Since sizes and CRC-32 must precede the data, a writer has to know them before writing an entry. The reference implementation therefore reads every document twice when sealing: once to compute SHA-256 and CRC-32, once to write it, and sealing fails if the size or CRC-32 differs on the second read. Documents up to 8 MiB are deflated in memory when that makes them smaller; larger documents are stored uncompressed and streamed, so their size never matters for memory. Entries are written as `mimetype`, `manifest.json`, `statement.json`, documents in manifest order, signatures, anchors.

## Paths

A manifest `path`:

- is converted to Unicode NFC;
- uses `/` as the separator, with no leading or trailing `/`;
- has no empty, `.`, or `..` segments;
- contains no C0 control characters (including NUL), no DEL (`0x7F`), and no `\`;
- is at most 1024 UTF-8 bytes.

After normalization, paths MUST be unique, and also unique when compared after locale-independent Unicode lowercasing **and** after locale-independent Unicode uppercasing (full mappings, as ECMAScript `toLowerCase()`/`toUpperCase()` and Python `str.lower()`/`str.upper()`), each followed by NFC normalization, to prevent collisions on case-insensitive file systems. The second NFC matters: `ß́` (`ß` with a combining acute) uppercases to `S` `S` `◌́`, which composes to `SŚ`, the uppercase of a path spelled `SŚ`. Two paths that are equal under either mapping collide: neither mapping alone matches file systems (`ΟΔΟΣ` lowercases with a final `ς`; `ß` only uppercases to `SS`). A path MUST NOT also be used as a directory of another path (`a` and `a/b`), under the same comparisons. Paths are sorted by their UTF-8 bytes.

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
- Verification follows RFC 8032 §5.1.7 with these additional rules, which every verifier MUST apply:
  - the public key `A` and the point `R` (the first 32 bytes of the signature) MUST be canonical encodings (`y < p`, and not `x = 0` with the sign bit set);
  - `S` MUST be less than the group order `L`;
  - `A` MUST NOT be of small order, and `A` and `R` MUST both be in the prime-order subgroup (`[L]P` is the identity). Then the cofactored equation `[8][S]B = [8]R + [8][k]A` and the cofactorless one `[S]B = R + [k]A` give the same answer, so verifiers built on different libraries agree. Without this rule a signer could add a point of order 8 to `R` or `A` and produce a signature that only some verifiers accept. Honestly generated keys and signatures always satisfy it.
- An Ed25519 `did:key` has 48 base58 characters after `did:key:z`. A `signer` with more than 64 characters there MUST be rejected before decoding, because base58 decoding takes quadratic time. Such an envelope has `signature: invalid`.

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
- v0.1 packages have at most one anchor file, named `anchors/seal-N.json` (normally `seal-1.json`). More than one anchor file makes `time: invalid`; none yields `time: missing`.
- `receipts` MUST contain at least one receipt. A receipt with a `digestAlgorithm` other than `sha-256` makes the anchor file unsupported. A receipt of a provider or network the verifier does not support is `unsupported`.
- Everything under `cached` is an untrusted hint. Status, time, and block height are always derived from the proof and a `ChainReader`.

### OpenTimestamps

- `network` MUST be `bip122:000000000019d6689c085ae165831e93` (Bitcoin mainnet); any other network is `unsupported`.
- `proof` is the binary `.ots` detached timestamp file for `seal`.
- A Bitcoin attestation is accepted as `confirmed` when its block has at least **6 confirmations** by default (configurable). Fewer confirmations, or only calendar (pending) attestations, yield `time: pending`.
- The attested time is the block header `time` of the attested block. It is accurate only to within about two hours.
- The report records which `ChainReader` source was used (own node, explorer URL, or several).
- Supported operations: `append`, `prepend`, `sha256`, `ripemd160`, `keccak256`, `reverse`, `hexlify`. RIPEMD-160 is accepted because early Bitcoin proofs (2015–2016) use it and it has no known practical attacks. Attestations reached through `sha1` are ignored, since SHA-1 has practical collisions.
- Parser limits follow the reference implementation: messages and operation arguments up to 4096 bytes (including the result of `append` and `prepend`), attestation payloads up to 8192 bytes, nesting up to 256, calendar URIs up to 1000 characters from `[A-Za-z0-9-._/:]`.
- In addition, a whole proof MAY have at most 10 000 timestamp nodes and 4 MiB of messages across all nodes. Each node keeps a message of up to 4096 bytes, so without this budget a small proof could expand to gigabytes in memory. Real proofs merged from several calendars have a few hundred nodes.
- Bitcoin attestations that repeat the same block height and message are checked once. A proof with more than **8 distinct** Bitcoin attestations is `invalid`: real proofs carry one or two, and each one costs requests to the `ChainReader`.
- A Bitcoin attestation whose message differs from the block's merkle root makes the receipt `invalid`, even if another attestation in it is genuine.
- When sealing, the seal is submitted to several calendars; at least two (or all, if fewer are configured) must accept it. Their answers are merged into one proof.
- `upgrade` contacts only calendars matching an allow-list (by default `https://*.calendar.opentimestamps.org`, `https://*.calendar.eternitywall.com`, `https://*.calendar.catallaxy.com`), because the calendar URL comes from the package.
- HTTP requests to calendars and to the `ChainReader` refuse redirects, so an allow-listed host cannot forward the client elsewhere. Response bodies are read incrementally and abandoned as soon as they exceed a size cap (10 000 bytes for calendar answers, 1024 bytes for Esplora answers).

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

- `format` is `invalid` if any check of the container (its structure and every entry's data), of `manifest.json`, or of `statement.json` fails as invalid, and `unsupported` only if none is invalid and at least one is unsupported. The order in which a verifier runs its checks must not change the verdict: a package with an unsupported manifest version and a damaged document is `invalid`.
- If `format` is not `valid`, nothing else is evaluated: `integrity: not-checked`, `signature: missing`, `trust: not-evaluated`, `time: missing`, `completeness: incomplete`.
- `integrity` is `invalid` if `manifestHash`, `packageId`, or `merkleRoot` of the statement does not match the manifest, or if any file is missing, modified (different size or hash), or extra (in the container but not in the manifest); otherwise `valid`.
- Each envelope is checked on its own: `invalid` if it is malformed, signs a different `statementHash`, or does not verify; `unsupported` if its version, suite, or profile is unknown or its `critical` is not empty; otherwise `valid`. The `signature` axis is `invalid` if any envelope is invalid or two envelopes have the same digest; else `valid` if at least one envelope is valid (`any-valid`); else `unsupported` if any is unsupported; else `missing`.
- Each receipt is `confirmed`, `pending`, `invalid`, or `unsupported` (no registered provider, no chain source, unknown network, or the source cannot be reached); an anchor file that is malformed or does not cover this statement and these envelopes counts as one `invalid` result. The `time` axis is `invalid` if any result is invalid; else `confirmed` if any receipt is confirmed, with the earliest attested time; else `pending` if any is pending; else `unsupported`.
- `trust` is `not-evaluated` without a trust policy or unless `signature` is `valid`.
- `completeness` is `full` when every manifest file was hashed and every signature and anchor was evaluated; `partial` when only some files were checked by design (future selective disclosure, never produced in v0.1); `incomplete` when a check could not run (a missing file, an unsupported envelope, an unsupported receipt or anchor file).
- `trust` is evaluated for every signer with a valid signature. It is `trusted` only when **every** such signer is trusted, `untrusted` when at least one of them is untrusted, and `unknown` otherwise. One trusted signer does not make the package trusted: a pinned author next to an unknown co-signer must not read as `valid`, or the stranger's signature would borrow the author's trust. Envelopes with an unsupported suite are not evaluated for trust; they make `completeness` `incomplete`.
- `overall: valid` only when `format: valid`, `integrity: valid`, `signature: valid` (policy satisfied), `trust: trusted`, `time: confirmed`, and `completeness: full`.
- `overall: invalid` when any axis is `invalid`.
- `overall: indeterminate` otherwise, for example pending time or an untrusted signer.

For integrity, the report distinguishes missing, modified, and extra files per path.

## Trusted keys file

Verifier configuration, not part of a package. Used by the pinned-keys `TrustPolicy` (`docseal verify --trust trusted-keys.json`):

```json
{
  "type": "docseal-trusted-keys",
  "version": 1,
  "keys": [
    { "id": "did:key:z6Mk...", "label": "Alice (legal department)" }
  ]
}
```

- `id` is compared byte for byte with `protected.signer`. No normalization is applied.
- `label` is shown in reports. DocSeal does not verify it: the person who writes this file vouches for it.
- Duplicate `id` values make the file invalid.
- A signer is `trusted` only if its signature is valid and its `id` is listed; otherwise `untrusted`. The package's `trust` axis requires every valid signer to be listed (see [Verdicts](#verdicts)).
- Validity periods and revocation are out of scope for v0.1.

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

The key is derived with scrypt from the passphrase in Unicode NFC, UTF-8 encoded, and encrypted with XChaCha20-Poly1305. `N` MUST be a power of two from 2^10 to 2^20, `r` MUST be 8 and `p` MUST be 1, so a tampered file cannot make a reader allocate gigabytes. JCS of the object without `ciphertext` is used as associated data. The CLI warns that this format is for development and that production keys belong in an HSM, KMS, or hardware token.

## Crypto agility

v0.1 is effectively fixed to SHA-256 and the `docseal-ed25519-v1` profile. Algorithm identifiers are kept in the data, but changing an algorithm happens through a new profile or specification version with its own test vectors, not through an arbitrary string.

## Changes

v0.1 does not change. Errata may clarify the text where it is ambiguous, but only towards the behavior both reference implementations already share and the vectors already pin; each erratum is listed here with its date. Anything else — a new rule, a relaxed rule, a new algorithm — goes into a new format version with its own `version` numbers in the documents, and verifiers keep accepting v0.1 packages.

Since release candidate 1 (2026-10-17), fuzzing led to three rules, each with vectors, before the freeze:

- paths are compared after case mapping **followed by NFC** ([Paths](#paths));
- deflated data is exactly one complete stream: no unfinished stream, no bytes after its end ([Container](#container));
- the format verdict is `invalid` whenever any check is invalid, `unsupported` only otherwise, whatever the order of checks.

## Test vectors

Published in [`spec/vectors/`](../spec/vectors/): JCS, paths, Merkle trees, signatures, seals, and 44 golden packages with required verdicts. JSON Schemas for every document are in [`spec/schemas/`](../spec/schemas/). Two independent implementations (TypeScript and [Python](../verifiers/python/)) reproduce all vectors.

### Ed25519 implementation note

Verifiers MUST reject public keys of small order (the eight points of order dividing 8, in any encoding), before or in addition to calling an Ed25519 library. With such a key, one signature verifies every message. Some widely used libraries (OpenSSL through Python `cryptography`, as of 2026) accept these keys; `signature.json` contains the cases.

Libraries also differ in the verification equation: some check it cofactored (`@noble/curves`), others cofactorless (OpenSSL). The prime-order subgroup rule above makes them agree, but most libraries do not apply it themselves; a verifier checks `[L]A` and `[L]R` before calling the library. `signature.json` contains signatures that pass only the cofactored check, and one with small-order components in `R` and `A` that cancel and pass both; all must be rejected.
