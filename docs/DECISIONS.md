# Decisions and Open Questions

## Positioning

DocSeal is an open-source reference implementation and portfolio project, not a ready-made replacement for DocuSign, a certificate authority, or a qualified electronic signature.

The value of the project lies in an open format, independent verification, a clear threat model, extensibility, and high-quality implementation, not in the number of supported networks and integrations.

## Settled decisions

- Apache License 2.0 with `NOTICE`.
- TypeScript monorepo.
- CLI before the Web UI.
- No own backend for `v0.1` and `v0.2`.
- The fat package is the default mode of the first version.
- A package is immutable once signed.
- Adding a file means creating a new version with new proofs, not modifying the old package.
- Plugin-first architecture.
- The first signature plugin is Ed25519.
- The first anchor plugin is OpenTimestamps.
- Plugins are registered explicitly by the application.
- Cryptographic primitives are not written in-house.
- Verification returns separate statuses for format, integrity, signature, trust, time, and completeness.
- Legal integrations and claims of legal validity are out of the MVP.
- The original design document of 2026-10-12 is archived in [`docs/archive/`](archive/); the documents in the repository root and `docs/` take precedence.

### Decided on 2026-10-16 for v0.1

| Question | Decision |
|---|---|
| Documentation language | All public documentation is in English. |
| Salt in v0.1 | Yes, mandatory: 16 random bytes per file in every Merkle leaf. Adding it later would require a new Merkle scheme. |
| Encodings | Hashes and salts in lowercase hex; signatures and proofs in base64url without padding; RFC 3339 UTC timestamps. |
| Merkle construction | RFC 6962-style split, leaf/node prefixes `0x00`/`0x01`, no duplication of unpaired nodes. |
| `signaturesSetHash` | `H("DocSeal/v1/signature-set\0" ‖ sorted envelope digests)`. |
| Empty package | Not allowed: at least one file and at least one signature. |
| Extra ZIP entries | Rejected in v0.1; easier to relax later than to tighten. |
| `crit` equivalent | `critical: string[]` in the statement and in `protected`; any unknown value yields `unsupported`. |
| Local key file | Development only: scrypt + XChaCha20-Poly1305 via `@noble/*`, with a CLI warning. |
| Bitcoin confirmations | 6 by default for `confirmed`, configurable. |
| Minimum runtime | Node.js ≥ 22 LTS. The core avoids `fs`/`Buffer` so it can run in browsers in v0.2. |
| OpenTimestamps implementation | Own parser/executor for the `.ots` serialization format (not a cryptographic primitive) instead of the legacy `javascript-opentimestamps`, so it is portable to the browser. |
| Hash functions in timestamp paths | SHA-256, RIPEMD-160, and Keccak-256 are executed; SHA-1 paths are ignored. RIPEMD-160 is required by real 2015–2016 Bitcoin proofs. |
| Calendar quorum | A seal must be accepted by at least two calendars when sealing. |
| Default chain source (CLI) | mempool.space Esplora API, then blockstream.info if it does not answer (`firstAvailableChainReader`); the source used is named in every report. `--chain` (repeatable) for a self-hosted Esplora, `--offline` to skip. A Bitcoin Core RPC reader is future work. |
| Independent verifier | Python, in `verifiers/python/`, written from the specification and checked in CI against the shared vectors. |
| Path case collisions | Compared both lowercased and uppercased; either match is a collision (found while writing the vectors: lowercasing alone misses `ΟΔΟΣ`/`οδος`). |
| CLI exit codes | `0` valid, `1` invalid, `2` indeterminate, `3` error. |
| Passphrase input | Hidden terminal prompt, or `DOCSEAL_PASSPHRASE` for scripts. Never a command-line argument, which would leak into shell history and process lists. |

See [FORMAT-v0.1.md](FORMAT-v0.1.md) for the normative details.

## Why `PackageStatement` exists

A signature only over the hash of the full manifest prevents selective disclosure: without the manifest, the disclosed Merkle root cannot be linked to the signature, and the full manifest reveals the list of files. Therefore the root is included directly in a small signed statement that can be transferred together with a separate Merkle proof.

## Why the passport is deferred

A PDF/JSON passport that only contains displayed hashes and the seal cannot be considered self-verifiable without the `.dseal` or an embedded proof bundle. The proof format must stabilize first; the passport can be designed afterwards.

## Realistic estimate

For a single developer:

- vertical CLI prototype: 2–3 weeks;
- a quality public `v0.1`: about 5–7 weeks;
- a production-oriented version with additional hardening and an audit: 6–9 months.

`v0.1` and `v0.2` are enough for a portfolio. The full original roadmap with PKI, GOST, ASiC-E, and server infrastructure would require a separate team and significantly more time.

## Criteria for a good portfolio release

- a short demo `seal → verify → mutate → invalid`;
- a published specification;
- test vectors;
- CI and a clear release process;
- negative tests and parser fuzzing;
- an honest threat model;
- browser verification without uploading files;
- if possible, a small independent verifier in another language.

## Open questions

- final project name and domain;
- how to verify Bitcoin in the browser and how to display the level of trust in the data source (v0.2);
