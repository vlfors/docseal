# Threat Model

## Protected properties

DocSeal aims to prove that:

1. the verified files match the signed composition;
2. the signature is mathematically valid for the stated key;
3. the configured `TrustPolicy` accepts or rejects that key;
4. the signed state existed no later than the confirmed time;
5. a partial verification is never presented as a complete one.

## Unprotected properties

DocSeal does not prove that a document is true, the signer's identity without an external trust system, the original creation time, that signing was voluntary, or legal validity.

## Main threats and mitigations

| Threat | Mitigation |
|---|---|
| A byte in a document is changed | SHA-256 and recomputing the tree yield a negative verdict |
| A document is replaced and the manifest recomputed | The signed statement binds `manifestHash` and `merkleRoot` |
| A file name or size is changed | Path and size are part of the tree leaf |
| A leaf is substituted for a node | Domain separation with `0x00` and `0x01` |
| Role or time in the signature envelope is changed | All meaningful fields are inside the signed `protected` payload |
| Small-order Ed25519 public key (one signature verifies every message) | Explicit rejection of all small-order encodings in every implementation; covered by shared vectors |
| Ed25519 signature that only some verifiers accept (a small-order component in `R` or `A`; cofactored vs cofactorless equation) | `A` and `R` must be in the prime-order subgroup, checked by every implementation; covered by shared vectors |
| Implementation-specific parsing (duplicate JSON keys, ZIP quirks) | Strict parsers in both implementations; golden packages for each case |
| Algorithm substitution | Suite identifier and version are covered by the signature |
| An unknown co-signer added next to a trusted signer | `trust: trusted` requires every valid signer to be trusted; one untrusted signer makes the package `untrusted` |
| Malicious plugin shipped in a package | Plugins are only registered explicitly by the application |
| Unknown algorithm or critical extension | `unsupported`, not a crash or a false success |
| Spoofed block explorer | The `ChainReader` source is shown in the report; an own node is preferred; a header must hash to the block the source named |
| Forged OpenTimestamps proof | The path is executed locally and must end in the merkle root of the attested block; one mismatching attestation makes the receipt `invalid` |
| Anchor copied from another package | The anchor file names the statement and envelope digests; the seal is recomputed from the package |
| Package-supplied calendar URL used to reach internal services (SSRF) | `upgrade` only contacts allow-listed calendar hosts over HTTPS, without ports or paths |
| Weak hash in a timestamp path | Attestations reached through SHA-1 are ignored |
| Small proof that expands to gigabytes or millions of chain requests | Node and total-message budgets in the `.ots` parser; repeated attestations checked once; more than 8 distinct Bitcoin attestations make the receipt `invalid` |
| Calendar or explorer that redirects or streams an endless response | Redirects refused; response bodies capped and abandoned once over the cap |
| Oversized `did:key` (quadratic base58 decoding) | Length checked before decoding |
| ZIP Slip | Absolute paths, `..`, symlinks, and ambiguous names are rejected |
| ZIP bomb | Limits on entry count, sizes, and compression ratio; declared sizes checked before inflating; entries may not overlap |
| ZIP parser differential (an unzip tool extracts other bytes than the verifier checked) | Local headers must match the central directory field by field; no data descriptors; entries must tile the archive with no gaps; CRC-32 checked |
| An entry that some tools extract under another name (Info-ZIP Unicode Path extra field) | The Unicode Path block is rejected; extra fields must be well formed with no repeated blocks |
| ZIP64 fields that tools read differently (classic and ZIP64 values that disagree, surplus fields) | Each classic field is a marker or equals its ZIP64 value; the ZIP64 block holds exactly the marked fields; the ZIP64 end record must sit right before its locator |
| Package or document too large for memory, to exhaust the verifier | Documents are streamed and hashed in 1 MiB chunks; deflate input is fed 64 KiB at a time; the central directory is limited to 64 MiB |
| Unicode/path collision | NFC, `/` separator, duplicates rejected after normalization and case folding |
| Unexpected extra entries in the container | Any entry not defined by the specification is rejected in v0.1 |
| Package text (file names, roles, error details) with terminal escape sequences or bidi marks that redraw the verdict | The CLI escapes control, bidirectional, and zero-width characters in every printed line |
| Calendar date that some parsers accept and others reject (`2026-02-30`) | Timestamps checked field by field against the calendar, not with a platform date parser |
| Partial verification shown as complete | Separate `completeness` and `overall` verdicts |
| A file being sealed swapped for a link or another file between listing and reading, to put a file the attacker cannot read into the package (TOCTOU) | The CLI refuses links when collecting, pins each file by device, inode, and size, opens it without following a final link, and checks the open descriptor against the pinned identity on every read; a directory must keep its identity across listing |
| Theft of a local key | Encrypted key file; production HSM/KMS providers |
| Removal of a signature or anchor | Signed policy and a report of missing required proofs |
| Brute-forcing a short hidden file | Random per-file leaf salt (see below) |

## The browser app

The web app (`apps/web`, v0.2) runs the same packages in the viewer's browser, from static files on GitHub Pages. Its own threats, each with the test or the stated mitigation that answers it:

| Threat | Mitigation | Checked by |
|---|---|---|
| A compromised build or host serves a different verifier (one that says `valid` to anything, or sends documents away) | The site is built by CI from a release tag and shows the commit it was built from; the same static site is attached to each GitHub Release with a build attestation, so it can be checked and served locally instead of trusting the hosted copy. Residual: a viewer who does neither trusts GitHub Pages and the account. | Stated (release steps, task 13) |
| Script from another origin (CDN, analytics, an injected tag) | A `<meta>` Content Security Policy: `default-src 'none'`, scripts and workers from the site only, inline scripts only by SvelteKit's hashes; nothing is loaded from elsewhere | `apps/web/src/csp.test.ts`; no violation in any engine, `tests/e2e/` |
| The page's workers reach a host the policy does not list (a `<meta>` policy does not apply to workers, and GitHub Pages sends none) | Workers fetch only through `browserFetch`, which refuses every origin but the calendars, upgrade hosts, and chain sources of `network.js` and the viewer's own Esplora | `apps/web/src/lib/network.test.ts` |
| A package that injects markup or script through a file name, role, signer, or message | Package text is rendered as text by Svelte; `{@html}` is rejected by ESLint | ESLint (`svelte/no-at-html-tags`), `tests/e2e/verify.e2e.test.ts` |
| A file name with a bidirectional override or invisible characters that disguises itself (`invoice<U+202E>txt.exe`) | Package text is isolated with `<bdi>`, and every control, zero-width, and bidirectional character is shown as its code point, the same set the CLI escapes | `apps/web/src/lib/text.test.ts` (whole BMP against the CLI), `tests/e2e/verify.e2e.test.ts` |
| Another site frames the page and lays its own verdict or buttons over it (clickjacking) | A `<meta>` policy cannot carry `frame-ancestors`, so the page refuses to work inside any frame | `tests/e2e/verify.e2e.test.ts` |
| A malicious page in another tab | The page listens to no messages from other windows, opens no windows, and keeps no secret in storage; nothing of a document or key is in the URL | `tests/e2e/seal.e2e.test.ts` (storage and URL after sealing) |
| Another project on the same origin (every GitHub Pages site of the account is `vlfors.github.io`) reads or changes the stored trusted keys | The list is shown in full on the verify page, with its names, and each key can be removed; it holds public keys only. The preview at `/docseal/preview/`, built from `main` rather than a tag, shares the origin and the stored list with the release. A custom domain gives DocSeal an origin of its own and removes the risk. Residual until then. | Stated |
| The secret key leaks from the page (a bug, an extension, a later script) | The key is opened and kept in a worker, which seals once and is terminated; the page holds only the `did:key`, a new key file is saved at once and dropped, and the passphrase field is cleared | `apps/web/src/lib/signer/run.test.ts`, `tests/e2e/seal.e2e.test.ts` |
| Documents or keys written to storage, logs, or URLs | Nothing is logged; storage holds the viewer's language, Bitcoin source, and trusted public keys only; packages leave the device only as a download or a file the viewer picks | `tests/e2e/seal.e2e.test.ts` |
| A package too large for memory, to crash the tab | Verification streams from the file in a worker; sealing streams to a picked file where the browser allows it, and elsewhere refuses above a measured limit | `apps/web/src/lib/verify/client.browser.test.ts`, `tests/browser/memory.browser.test.ts`, `tests/e2e/large.e2e.test.ts` |
| A document changed while it is sealed | The core's CRC check between the two reads, and the browser's `NotReadableError`; nothing is saved | `apps/web/src/lib/signer/run.test.ts` |
| A calendar or chain source that lies or is unreachable | As in the CLI: proofs are executed locally, the chain source is named in the report and trusted only for which block is at a height; an unreachable calendar on upgrade reads as "not yet", which the page says | `apps/web/src/lib/verify/run.test.ts`, `tests/e2e/time.e2e.test.ts` |

## Critical format rules

### Protected signature payload

The signature must bind:

- the protocol version;
- the suite and profile;
- the key identifier or fingerprint;
- the role;
- the claimed time;
- `statementHash`;
- additional signed attributes;
- the list of critical extensions.

Interface fields that affect the meaning of the signature must not live only outside the signed payload.

### Selective disclosure

Signing only `manifestHash` is not enough: a verifier without the full manifest cannot prove that a disclosed `merkleRoot` is linked to the signature. Therefore the root must be part of the signed `PackageStatement` directly.

### Per-file salt

A Merkle proof reveals the leaf hashes of neighboring files. Without a salt, an attacker who can guess a short, predictable document (a template contract, a "yes/no" answer, a small amount) can hash the candidates and match them against the leaf. A 16-byte random salt per file makes this infeasible. The salt is mandatory from v0.1 so that enabling selective disclosure later does not require a new Merkle scheme.

### Passport

A derived passport without the embedded statement, signatures, and anchor proof is not a self-contained proof. It can only be a report verified together with the `.dseal`, or it must include a minimal proof bundle. Publishing plain SHA-256 file hashes enables dictionary attacks on predictable content.

### Timestamp status

A stored `status: confirmed` field is a hint, not a proof. The verifier must check the receipt itself and obtain the confirmed time from a trusted `ChainReader` or TSA.

### Determinism

Sealing the same files again with fresh random salts is not required to produce the same root. The determinism requirement applies to verifying the same manifest and its salts on different platforms.

## Residual risks

- implementation bugs in libraries and runtimes;
- device compromise before signing;
- a misconfigured `TrustPolicy`;
- browser-side OpenTimestamps verification depending on an external data source;
- Bitcoin block timestamps being accurate only to within about two hours;
- losing the ability to verify old algorithms and certificates;
- a user interface that hides an incomplete or untrusted result;
- a browser extension with access to the page, which can read documents and keys as the page does;
- in the web app, the host serving the page (see "The browser app").

An independent audit is required before claiming production-grade security.
