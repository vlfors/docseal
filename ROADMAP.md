# DocSeal Roadmap

This roadmap describes the current direction of the project. It is not a commitment to ship features by specific dates. Priorities may change after security review and feedback.

## v0.1 — Core and CLI

- [ ] Freeze the versioned `.dseal` specification.
- [x] Implement a safe fat package with documents inside.
- [x] Add `manifest.json`, `statement.json`, and JSON Schemas.
- [ ] Implement streaming SHA-256 hashing.
- [x] Implement the Merkle tree and publish test vectors.
- [x] Implement the `SignatureSuite`, `KeyProvider`, and `TrustPolicy` interfaces.
- [x] Implement the Ed25519 plugin and a development-only local key file.
- [x] Implement `AnchorProvider` and the OpenTimestamps plugin.
- [x] Implement the CLI: `keygen`, `seal`, `verify`, `upgrade`.
- [x] Return a machine-readable report with separate verification axes.
- [ ] Add mutation tests, property tests, and parser fuzzing.
- [ ] Set up CI, signed releases, and documentation.

### Implementation order

1. **Scaffold:** pnpm monorepo (`spec/`, `packages/core`, `packages/sig-ed25519`, `packages/anchor-ots`, `apps/cli`), strict TypeScript, tsup, Vitest, ESLint, CI.
2. **Vertical prototype:** one file → manifest → statement → Ed25519 → `.dseal` → verify; a one-byte change yields `invalid`. No anchoring yet. *Done in the library; in-memory only. Remaining: streaming container I/O for large files, ZIP64.*
3. **Multiple files and policies:** plugin registry, pinned-keys `TrustPolicy`, `any-valid` signature policy, missing/modified/extra file detection, `unsupported` for unknown suites and critical extensions. *Done.*
4. **OpenTimestamps:** `.ots` parser and executor, calendar submission, `upgrade`, Bitcoin header check through a configurable `ChainReader`. Tests use recorded proofs, no network in CI. *Done; checked live against public calendars and mempool.space.*
5. **CLI:** `keygen`, `seal`, `verify --trust --json`, `upgrade`; distinct exit codes; human and JSON reports with the same content. *Done; also `pubkey`. Demonstrated against the public calendars and mempool.space.*
6. **Quality and release:** test vectors cross-checked by an independent script, negative tests for every threat-model row, fast-check properties, parser fuzzing, ≥ 90 % core coverage, `CHANGELOG.md`, `CONTRIBUTING.md`, npm provenance, demo `seal → verify → mutate → invalid`.

Explicitly deferred from v0.1: selective disclosure (only the proof-building function and `merkleRoot` in the statement are in place), co-signing and M-of-N, `previous` versions, the package passport, RFC 3161, WebAuthn, any server, standalone binaries.

## v0.2 — Browser interface

- [ ] Create a package from selected files or a folder.
- [ ] Verify `.dseal` locally without uploading documents to a server.
- [ ] Drag-and-drop.
- [ ] Web Workers and streaming processing of large files.
- [ ] Clear human-readable report.
- [ ] Static demo application.

## Future exploration

These directions are not promised for a specific release:

- thin packages without embedded documents;
- selective disclosure of a single file with a Merkle proof;
- package version history;
- multiple independent signatures and M-of-N policies;
- WebAuthn;
- RFC 3161;
- X.509/CMS;
- package passport in JSON/PDF;
- an independent verifier in Rust or Python;
- a server for background `upgrade`, batching, and webhooks.

## Experimental integrations

Research directions to demonstrate enterprise applicability:

- HSM and PKCS#11 through `KeyProvider`;
- cloud KMS and enterprise remote-signing services;
- enterprise PKI and configurable `TrustPolicy`;
- key rotation and revocation;
- a transparent audit log;
- threshold signatures and MPC/FROST through vetted external implementations;
- GOST through a local CryptoPro or Rutoken agent.

Threshold-signature protocols must not be implemented within the project itself.

## Out of scope for the first releases

- storing user documents on a server;
- KYC and identity verification;
- claims of legal validity;
- qualified electronic signatures;
- EVM contracts and a custom blockchain;
- simultaneous official support for Node.js, Deno, Bun, and a standalone binary.

## How work is organized

- `ROADMAP.md` holds the major directions.
- GitHub Issues describe individual implementable tasks.
- GitHub Milestones group tasks by `v0.1`, `v0.2`, and later versions.
- A GitHub Project may be used as a `Backlog → Ready → In progress → Done` board.
- `CHANGELOG.md` is created before the first release and lists released changes only.
- GitHub Releases publishes versions, artifacts, and release notes.

Prefer promising the contents of a version over exact dates.
