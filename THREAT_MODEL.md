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
| Algorithm substitution | Suite identifier and version are covered by the signature |
| Malicious plugin shipped in a package | Plugins are only registered explicitly by the application |
| Unknown algorithm or critical extension | `unsupported`, not a crash or a false success |
| Spoofed block explorer | The `ChainReader` source is shown in the report; an own node is preferred; a header must hash to the block the source named |
| Forged OpenTimestamps proof | The path is executed locally and must end in the merkle root of the attested block; one mismatching attestation makes the receipt `invalid` |
| Anchor copied from another package | The anchor file names the statement and envelope digests; the seal is recomputed from the package |
| Package-supplied calendar URL used to reach internal services (SSRF) | `upgrade` only contacts allow-listed calendar hosts over HTTPS, without ports or paths |
| Weak hash in a timestamp path | Attestations reached through SHA-1 are ignored |
| ZIP Slip | Absolute paths, `..`, symlinks, and ambiguous names are rejected |
| ZIP bomb | Limits on entry count, sizes, and compression ratio |
| Unicode/path collision | NFC, `/` separator, duplicates rejected after normalization and case folding |
| Unexpected extra entries in the container | Any entry not defined by the specification is rejected in v0.1 |
| Partial verification shown as complete | Separate `completeness` and `overall` verdicts |
| Theft of a local key | Encrypted key file; production HSM/KMS providers |
| Removal of a signature or anchor | Signed policy and a report of missing required proofs |
| Brute-forcing a short hidden file | Random per-file leaf salt (see below) |

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
- a user interface that hides an incomplete or untrusted result.

An independent audit is required before claiming production-grade security.
