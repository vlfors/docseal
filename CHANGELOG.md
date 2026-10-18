# Changelog

All notable changes to DocSeal are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change the library API; the `.dseal` format has its own version, and a package valid under format v0.1 stays valid for every DocSeal release that supports v0.1.

All packages (`@docseal/core`, `@docseal/sig-ed25519`, `@docseal/anchor-ots`, `@docseal/cli`) are released together with the same version.

## [0.1.0] — Unreleased

The first release: the `.dseal` format v0.1, a TypeScript library, and the `docseal` CLI.

### Format

- `.dseal` v0.1: a ZIP container with the documents, `manifest.json`, `statement.json`, signature envelopes, and anchor files. The [specification](docs/FORMAT-v0.1.md) is frozen with this release.
- Documents are bound by a salted Merkle tree (RFC 6962 style) whose root the signed statement contains; JSON is hashed in RFC 8785 canonical form.
- A seal digest commits to the statement and to every signature, and is what gets timestamped.
- Verification reports six separate axes (format, integrity, signature, trust, time, completeness) and an overall verdict: `valid`, `invalid`, or `indeterminate`.
- JSON Schemas for every document, test vectors (JCS, paths, Merkle trees, signatures, seals), and 44 golden packages with required verdicts in [`spec/`](spec/).

### Library

- `@docseal/core`: the format, streaming hashing and container I/O (ZIP64 beyond 4 GiB), the verification pipeline, and the plugin interfaces `SignatureSuite`, `KeyProvider`, `TrustPolicy`, `AnchorProvider`, and `ChainReader`. Packages name plugins; applications register them, and anything unregistered is `unsupported`, never skipped.
- `@docseal/sig-ed25519`: Ed25519 signatures with `did:key` signer identifiers, strict verification (canonical encodings, points in the prime-order subgroup), and a passphrase-encrypted key file for development use.
- `@docseal/anchor-ots`: OpenTimestamps submission, upgrade, and verification against Bitcoin block headers from a configurable Esplora source.
- A pinned-keys trust policy and its `trusted-keys.json` file format.

### CLI

- `docseal keygen`, `pubkey`, `seal`, `verify`, and `upgrade`, with human and JSON reports and distinct exit codes (0 valid, 1 invalid, 2 indeterminate, 3 error).
- `verify` reads block headers from mempool.space and falls back to blockstream.info; `--chain` is repeatable for your own sources.

### Security

- Strict, bounded parsers for hostile input: ZIP (local headers matched against the central directory, no overlaps or gaps, no data descriptors, Unicode Path fields rejected, size and ratio limits), JSON (duplicate keys, I-JSON numbers, nesting), paths (NFC, collisions after case mapping), deflate (exactly one complete stream), and OpenTimestamps proofs (size, depth, and node limits).
- Ed25519 verification requires `A` and `R` in the prime-order subgroup, so verifiers using cofactored and cofactorless equations agree.
- `docseal seal` pins every collected file by identity and size and checks each read against it, so a file swapped for a link or another file while sealing is reported, not sealed.
- An independent Python verifier (OpenSSL and libsodium, no curve arithmetic of its own) reproduces every vector; differential fuzzing checks that both implementations agree on mutated packages.
- See the [threat model](THREAT_MODEL.md) and the [testing guide](docs/TESTING.md).
