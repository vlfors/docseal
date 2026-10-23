# DocSeal Roadmap

This roadmap describes the current direction of the project. It is not a commitment to ship features by specific dates. Priorities may change after security review and feedback.

## v0.1 — Core and CLI

- [x] Freeze the versioned `.dseal` specification. *[FORMAT-v0.1.md](docs/FORMAT-v0.1.md) is final.*
- [x] Implement a safe fat package with documents inside.
- [x] Add `manifest.json`, `statement.json`, and JSON Schemas.
- [x] Implement streaming SHA-256 hashing, streaming container I/O, and ZIP64.
- [x] Implement the Merkle tree and publish test vectors.
- [x] Implement the `SignatureSuite`, `KeyProvider`, and `TrustPolicy` interfaces.
- [x] Implement the Ed25519 plugin and a development-only local key file.
- [x] Implement `AnchorProvider` and the OpenTimestamps plugin.
- [x] Implement the CLI: `keygen`, `seal`, `verify`, `upgrade`.
- [x] Return a machine-readable report with separate verification axes.
- [x] Add mutation tests, property tests, and parser fuzzing. *See [TESTING.md](docs/TESTING.md).*
- [x] Set up CI, signed releases, and documentation. *CI with coverage floor and package smoke test; tag-driven releases with npm provenance and attested tarballs ([RELEASING.md](docs/RELEASING.md)); [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), demo. The first publication waits for the public repository.*

### Implementation order

1. **Scaffold:** pnpm monorepo (`spec/`, `packages/core`, `packages/sig-ed25519`, `packages/anchor-ots`, `apps/cli`), strict TypeScript, tsup, Vitest, ESLint, CI.
2. **Vertical prototype:** one file → manifest → statement → Ed25519 → `.dseal` → verify; a one-byte change yields `invalid`. No anchoring yet. *Done; packages larger than memory are sealed and verified as streams, with ZIP64 beyond 4 GiB.*
3. **Multiple files and policies:** plugin registry, pinned-keys `TrustPolicy`, `any-valid` signature policy, missing/modified/extra file detection, `unsupported` for unknown suites and critical extensions. *Done.*
4. **OpenTimestamps:** `.ots` parser and executor, calendar submission, `upgrade`, Bitcoin header check through a configurable `ChainReader`. Tests use recorded proofs, no network in CI. *Done; checked live against public calendars and mempool.space.*
5. **CLI:** `keygen`, `seal`, `verify --trust --json`, `upgrade`; distinct exit codes; human and JSON reports with the same content. *Done; also `pubkey`. Demonstrated against the public calendars and mempool.space.*
6. **Quality and release:** test vectors cross-checked by an independent script, negative tests for every threat-model row, fast-check properties, parser fuzzing, ≥ 90 % core coverage, `CHANGELOG.md`, `CONTRIBUTING.md`, npm provenance, demo `seal → verify → mutate → invalid`. *Done; core line coverage is about 97 %.*

Explicitly deferred from v0.1: selective disclosure (only the proof-building function and `merkleRoot` in the statement are in place), co-signing and M-of-N, `previous` versions, the package passport, RFC 3161, WebAuthn, any server, standalone binaries.

## v0.2 — Browser interface

The same core in the browser; the `.dseal` format does not change.

- [x] Create a package from selected files or a folder.
- [x] Verify `.dseal` locally without uploading documents to a server.
- [x] Drag-and-drop.
- [x] Web Workers and streaming processing of large files.
- [x] Clear human-readable report.
- [x] Static demo application (served from the first release; see [releasing](docs/RELEASING.md)).

Also in v0.2: keys opened or created in the browser, compatible with the CLI; time proofs submitted, completed, and checked against Bitcoin in the browser; English and Russian; tests in Chromium, Firefox, and WebKit.

## v0.3 — MCP server for AI agents

The same core for AI agents, through one [Model Context Protocol](https://modelcontextprotocol.io) server that any MCP client can use; the `.dseal` format does not change.

- [ ] `@docseal/mcp`, a local stdio server: verify a package, inspect its contents, and complete its time proof.
- [ ] Package content treated as untrusted input to a model: text from a package never reaches a tool's summary, and an indeterminate verdict says first what is not confirmed.
- [ ] Trust stays with the person: trusted keys come from the server's configuration, and no tool changes them.
- [ ] Sealing off by default: turned on by the person running the server, with a key from its configuration, confirmed by the person for each package, and a passphrase that never passes through the model.
- [ ] File access limited to the directories the client or the person allows.
- [ ] A skill that teaches agents to read the verdicts, configuration examples for common MCP clients, and threat model rows for agents.

## v0.4 — Instant timestamps (RFC 3161)

- [ ] Format v0.2: an RFC 3161 receipt as a second anchor next to OpenTimestamps, so a package gets a time from a trusted timestamp authority within seconds and independent confirmation in Bitcoin a few hours later. Packages in format v0.1 stay valid.
- [ ] Pinned timestamp authorities, like pinned signer keys, and a report that keeps an authority's time apart from Bitcoin's.
- [ ] Verification through a vetted CMS/ASN.1 library, in TypeScript and in the Python verifier, with vectors, fuzzing, and a dedicated security review.
- [ ] Decide how the browser reaches timestamp authorities that do not allow cross-origin requests, without a server holding documents.

## Future exploration

These directions are not promised for a specific release:

- thin packages without embedded documents;
- selective disclosure of a single file with a Merkle proof;
- package version history;
- M-of-N signature policies (several signers per package already work, under `any-valid`);
- WebAuthn;
- X.509/CMS;
- package passport in JSON/PDF;
- an independent verifier in Rust (one in Python exists since v0.1);
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
