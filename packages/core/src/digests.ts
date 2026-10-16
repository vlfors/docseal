/** Domain-separated digests from FORMAT-v0.1 §Signature envelope and §Seal. */
import { compareBytes, equalBytes, hash, utf8 } from "./bytes.js";
import { FormatError } from "./errors.js";
import { jcs } from "./json.js";

const SIGNATURE_DOMAIN = utf8("DocSeal/v1/signature\0");
const SIGNATURE_SET_DOMAIN = utf8("DocSeal/v1/signature-set\0");
const ANCHOR_DOMAIN = utf8("DocSeal/v1/anchor\0");

/** H(JCS(value)): `manifestHash`, `statementHash`, and envelope digests. */
export function jsonHash(value: unknown): Uint8Array {
  return hash(jcs(value));
}

/** The exact bytes a signature suite signs and verifies. */
export function signedBytes(protectedHeader: unknown): Uint8Array {
  const digest = jsonHash(protectedHeader);
  const out = new Uint8Array(SIGNATURE_DOMAIN.length + digest.length);
  out.set(SIGNATURE_DOMAIN);
  out.set(digest, SIGNATURE_DOMAIN.length);
  return out;
}

/** Commits to a set of envelopes independently of their order or ZIP file names. */
export function signaturesSetHash(envelopeDigests: readonly Uint8Array[]): Uint8Array {
  const sorted = [...envelopeDigests].sort(compareBytes);
  for (let i = 1; i < sorted.length; i++) {
    if (equalBytes(sorted[i - 1] ?? new Uint8Array(), sorted[i] ?? new Uint8Array())) {
      throw new FormatError("duplicate-signature", "The package contains the same signature envelope twice");
    }
  }
  return hash(SIGNATURE_SET_DOMAIN, ...sorted);
}

/** The digest submitted to anchor providers. */
export function sealDigest(statementHash: Uint8Array, setHash: Uint8Array): Uint8Array {
  return hash(ANCHOR_DOMAIN, statementHash, setHash);
}
