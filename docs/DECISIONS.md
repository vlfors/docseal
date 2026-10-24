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

### Decided on 2026-10-18 for v0.2 (browser interface)

| Question | Decision |
|---|---|
| Framework | SvelteKit with `adapter-static`: every page is prerendered as a static shell and runs in the browser only. No server code, and nothing about a user's documents or keys ever reaches a server. |
| Hosting | GitHub Pages, built and deployed by CI from a release tag; the page shows the commit it was built from. The same static site is attached to each GitHub Release, attested like the npm tarballs, so anyone can serve it locally instead of trusting the hosted copy. |
| Content Security Policy | GitHub Pages cannot set response headers, so the CSP is a `<meta>` tag with hashes of SvelteKit's inline scripts (`kit.csp`): scripts and workers from the site only, `connect-src` limited to the calendars and chain sources, no third-party resources of any kind (no CDN, fonts, or analytics). |
| Framing | A `<meta>` CSP cannot carry `frame-ancestors`, so the page refuses to work inside a frame and offers a link to open it directly; this stops another site from overlaying its own buttons or verdict. |
| Supported browsers | Current desktop Chrome, Edge, Firefox, and Safari, each tested in CI (Chromium, Firefox, WebKit). Mobile browsers on a best-effort basis. |
| Where the work runs | Verifying, sealing, and opening a key file (scrypt) run in Web Workers. Documents and key material stay in the worker; only reports and progress reach the page. |
| Keys | A key can be generated in the browser; it is downloaded at once as an encrypted key file in the same format as `docseal keygen`, so the CLI opens it too. A key file can be opened with its passphrase. The page never stores a secret key: it lives in worker memory for one sealing. Same scrypt parameters as the CLI. |
| Trusted keys | Kept in the viewer's browser storage only, with import and export as `trusted-keys.json`; the page says so. |
| Saving a sealed package | Streamed to disk through the File System Access API where it exists (Chrome, Edge). Elsewhere (Firefox, Safari) the package is built in memory and downloaded, up to a limit measured per browser before release (about 1 GiB expected); above it, the page refuses and explains why. No service-worker download tricks. |
| Calendars from the browser | The default calendars that allow cross-origin requests (three of the four as of 2026-10-18; `ots.btc.catallaxy.com` does not); the quorum of two still applies. None of them answers a CORS preflight (checked 2026-10-20), so the browser sends only simple requests, without the `User-Agent` header the CLI sends. A calendar's "not committed yet" (404) carries no CORS header and reads in a browser like an unreachable calendar; an upgrade treats both as "not yet", and the page says so. A completed proof is served with CORS headers: a package sealed in the browser on 2026-10-20 was upgraded and verified as `valid` there, entirely on the real network, under two hours later. |
| Bitcoin in the browser | The same Esplora sources with fallback as the CLI (`firstAvailableChainReader`); mempool.space and blockstream.info both allow cross-origin requests (checked 2026-10-20). The report names the source that answered and says what it is trusted for: which block is at a height. Users can name their own Esplora instance (https, or http to localhost), and verify offline. |
| Languages | English and Russian from the start, chosen from the browser language with a switch. Strings live in a typed dictionary per language, without an i18n library; a missing translation fails the type check. |

This answers the open question of how to verify Bitcoin in the browser and show the trust in the data source.

### Decided on 2026-10-23 for v0.3 (MCP server)

| Question | Decision |
|---|---|
| Package | `apps/mcp`, published as `@docseal/mcp` with the binary `docseal-mcp`, versioned with the other packages. |
| SDK and protocol | The official TypeScript SDK v2 (`@modelcontextprotocol/server`, the stable line since 2026-07-27), pinned. Its runtime dependencies are only `zod` and the SDK's own core, where v1 (`@modelcontextprotocol/sdk`) pulls in an HTTP stack the server would never use. Started with `serveStdio`, which serves both the 2026-07-28 protocol and clients still on the 2025 handshake (2025-11-25 and 2025-06-18). |
| Transport | stdio only, started by the client as a local process. No HTTP transport: a network service that reads documents is out of scope ("storing user documents on a server"). |
| Tools | `verify`, `inspect`, `upgrade`, and `list_trusted_keys` always; `seal` only when sealing is turned on. Each has an output schema, returns `structuredContent`, and carries annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Tools are listed in a fixed order. |
| Text sent to the model | The text block starts with a summary built only from DocSeal's own fixed phrases (verdict, counts, what is not confirmed, next steps), followed by the structured result as JSON, as the specification recommends for clients that read only text. Text from a package appears only as escaped, sanitized, length-capped values of named JSON fields: data can be fenced and labelled for the model, never hidden from it. |
| Configuration | Command-line flags in the client's server entry, with the CLI's names where they overlap: `--root <dir>` (repeatable), `--trust <file>`, `--chain <url>` (repeatable), `--offline`, `--allow-seal`, `--key <file>`. `DOCSEAL_PASSPHRASE` in the server's environment, as in the CLI. Nothing is read from a configuration file of its own. |
| File access | Only under the `--root` directories; no `--root`, no file access. MCP roots are not used: the 2026-07-28 specification deprecates them (SEP-2577) and recommends server configuration instead. Paths are resolved, symlinks included, before the check. |
| Trusted keys | From the `--trust` file only, read at each call. No tool adds, removes, or edits a key: a package, or anything else the agent reads, could otherwise talk it into trusting an attacker's key. Without `--trust`, trust is not evaluated, as in the CLI. |
| Sealing | Off unless the server is started with `--allow-seal --key <file>`; the key path never comes from the agent. Each `seal` call asks the person to confirm through form-mode elicitation, showing the files (count, total size, names), role, title, and the signer's `did:key`; declined, cancelled, or a client without elicitation means nothing is sealed. Such clients can still verify, inspect, and upgrade. The key is opened per call and dropped afterwards. |
| Passphrase | From `DOCSEAL_PASSPHRASE` in the server's environment only, never a tool argument or anything the model sees. Not through URL-mode elicitation: it would need a local web page served by DocSeal, and of the clients checked on 2026-10-23 only Claude Code and VS Code support it. |
| Network | As in the CLI: the seal digest to the OpenTimestamps calendars when sealing or upgrading, Bitcoin block headers from mempool.space then blockstream.info (or `--chain`, or `--offline`). Documents never leave the machine. |
| Logs | stderr only; stdout carries protocol messages and nothing else. MCP logging is deprecated in the 2026-07-28 specification. |
| Distribution | npm publishing stays off (`NPM_PUBLISH`), so the release tarball must install on its own: the server is bundled with the `@docseal/*` workspace packages inside, and lists their third-party dependencies (`@noble/*`, `@scure/base`, `canonicalize`, `fflate`) and the SDK as ordinary npm dependencies. Installed with `npm install -g <release tarball URL>`; `npx @docseal/mcp` once npm publishing is turned on. The CLI is built the same way (decided 2026-10-24), and both tarballs carry an `npm-shrinkwrap.json`. |
| Clients documented | Claude Code, Claude Desktop, Cursor, and Hermes Agent (`mcp_servers` in `~/.hermes/config.yaml`), each checked against the client's own documentation when the guide is written. |

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
