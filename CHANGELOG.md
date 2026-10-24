# Changelog

All notable changes to DocSeal are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version may change the library API; the `.dseal` format has its own version, and a package valid under format v0.1 stays valid for every DocSeal release that supports v0.1.

All packages (`@docseal/core`, `@docseal/sig-ed25519`, `@docseal/anchor-ots`, `@docseal/cli`) are released together with the same version.

## Unreleased

### MCP server

- `@docseal/mcp`: the `docseal-mcp` server for AI agents, over stdio, for clients on the 2026-07-28 protocol and on the 2025 handshake. Work in progress. Tools: `verify`, with the verdict, what it does not confirm, next steps, and the same report as `docseal verify --json`; `inspect`, what a package holds, without checking it; `upgrade`, which completes the time proof into `<name>.upgraded.dseal` (or over the original with `overwrite`) and says how far it has come. Files only under `--root`. Text from a package reaches the model only as values of named fields, with hidden and reordering characters made visible and each value and list capped; the summary is DocSeal's own words.

## [0.2.0] — 2026-10-22

The first release: the `.dseal` format v0.1, a TypeScript library, the `docseal` CLI, and a browser app. (0.1.0, the core and CLI alone, was never published; its work is part of this release.)

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
- A report's time proofs name the Bitcoin block they were checked against (`blockHeight`, also for a proof with too few confirmations) and the submission time the package records (`submittedAt`, a claim, not evidence). `upgradePackageTo` returns the anchor files as upgraded, so a caller can check the new proofs without reading the package again.

### CLI

- `docseal keygen`, `pubkey`, `seal`, `verify`, and `upgrade`, with human and JSON reports and distinct exit codes (0 valid, 1 invalid, 2 indeterminate, 3 error).
- `verify` reads block headers from mempool.space and falls back to blockstream.info; `--chain` is repeatable for your own sources. The report names the block a proof is in, and for a pending one its confirmations so far.

### Browser app

- A static site (`apps/web`) that verifies and seals packages on the device, served by GitHub Pages at [vlfors.github.io/docseal](https://vlfors.github.io/docseal/) and attached to the release as `docseal-web-0.2.0.tar.gz`, attested, to serve yourself. Every page names the release and the commit it was built from. A preview built from `main` is served at `/docseal/preview/`, beside the release and never in its place; it says on every page that it is not a release and links to the release.
- Verify: drop a package; the report shows the verdict, the six axes, the files, signatures, time proofs, and issues, with next steps. Trusted keys are added as `did:key` or imported from `trusted-keys.json`, kept in the browser, and exported again. Time proofs are checked against Bitcoin through mempool.space then blockstream.info, your own Esplora instance, or not at all. A package whose time proof is pending, as one is right after sealing, is marked as needing its time proof completed, under the verdict. An unchanged, correctly signed package that is not fully confirmed says so first, and lists what is not confirmed apart.
- Timestamp: completes a pending time proof. The page shows its stage (sent to the calendars, in a block, confirmed) with the block and its confirmations out of 6, asks the calendars when a package is chosen, again on request or every 10 minutes while the page is open, and saves the completed proof into the package.
- Seal: choose files or a folder (paths as `docseal seal` gives them, every path problem shown before sealing), open a key file made by `docseal keygen` or create one the CLI opens, and save the package straight to disk in Chrome and Edge or as a download elsewhere (up to 2 GiB in Firefox, 1 GiB in Safari). The seal is submitted to the OpenTimestamps calendars that accept requests from a browser. A log shows each step as it happens, with each calendar's answer.
- Verification and sealing run in Web Workers; the secret key lives in its worker for one sealing and never reaches the page. English and Russian.
- `@docseal/sig-ed25519`: `openKeyFile` and `createKeyFile` take an optional `onProgress` for scrypt.

### Security

- Strict, bounded parsers for hostile input: ZIP (local headers matched against the central directory, no overlaps or gaps, no data descriptors, Unicode Path fields rejected, size and ratio limits), JSON (duplicate keys, I-JSON numbers, nesting), paths (NFC, collisions after case mapping), deflate (exactly one complete stream), and OpenTimestamps proofs (size, depth, and node limits).
- Ed25519 verification requires `A` and `R` in the prime-order subgroup, so verifiers using cofactored and cofactorless equations agree.
- `docseal seal` pins every collected file by identity and size and checks each read against it, so a file swapped for a link or another file while sealing is reported, not sealed.
- An independent Python verifier (OpenSSL and libsodium, no curve arithmetic of its own) reproduces every vector; differential fuzzing checks that both implementations agree on mutated packages.
- The browser app runs under a Content Security Policy that loads nothing from other origins; its workers reach only the calendars and chain sources it lists. Package text is shown as text with every control and bidirectional character made visible, the page refuses to work inside a frame, and nothing of a document or a secret key is stored.
- The golden packages get their verdicts in Chromium, Firefox, and WebKit, and the built site is tested end to end in all three on a fake network; no source file may hold an invisible or bidirectional character.
- See the [threat model](THREAT_MODEL.md) and the [testing guide](docs/TESTING.md).
