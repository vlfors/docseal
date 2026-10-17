/** Ed25519 signature suite, profile `docseal-ed25519-v1` (FORMAT-v0.1 §Profile). */
import type { KeyProvider, SignatureCheck, SignatureSuite } from "@docseal/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";

export * from "./keyfile.js";

export const SUITE_ID = "ed25519";
export const PROFILE_ID = "docseal-ed25519-v1";

const DID_KEY_PREFIX = "did:key:z";
// Multicodec `ed25519-pub` (0xed) as an unsigned varint.
const ED25519_MULTICODEC = Uint8Array.of(0xed, 0x01);
const PUBLIC_KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;

export function publicKeyToDid(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) {
    throw new RangeError("An Ed25519 public key is 32 bytes");
  }
  const bytes = new Uint8Array(ED25519_MULTICODEC.length + PUBLIC_KEY_LENGTH);
  bytes.set(ED25519_MULTICODEC);
  bytes.set(publicKey, ED25519_MULTICODEC.length);
  return DID_KEY_PREFIX + base58.encode(bytes);
}

/** Throws if `did` is not an Ed25519 `did:key`. */
export function didToPublicKey(did: string): Uint8Array {
  // An Ed25519 did:key has 48 base58 characters; check before decoding, which is quadratic.
  if (!did.startsWith(DID_KEY_PREFIX) || did.length > DID_KEY_PREFIX.length + 64) {
    throw new Error("Expected a base58btc Ed25519 did:key");
  }
  const bytes = base58.decode(did.slice(DID_KEY_PREFIX.length));
  if (
    bytes.length !== ED25519_MULTICODEC.length + PUBLIC_KEY_LENGTH ||
    bytes[0] !== ED25519_MULTICODEC[0] ||
    bytes[1] !== ED25519_MULTICODEC[1]
  ) {
    throw new Error("did:key is not an Ed25519 public key");
  }
  return bytes.slice(ED25519_MULTICODEC.length);
}

/**
 * Strict RFC 8032 verification: canonical encodings only (no ZIP-215), and keys of small
 * order are rejected, since one signature then verifies every message. noble's strict mode
 * rejects such keys too; the explicit check keeps the guarantee independent of its defaults.
 */
export function ed25519Suite(): SignatureSuite {
  return {
    id: SUITE_ID,
    profiles: [PROFILE_ID],
    verify(signer, signedBytes, signature, profile) {
      return Promise.resolve(verifyStrict(signer, signedBytes, signature, profile));
    },
  };
}

function verifyStrict(signer: string, message: Uint8Array, signature: Uint8Array, profile: string): SignatureCheck {
  if (profile !== PROFILE_ID) {
    return "unsupported";
  }
  if (signature.length !== SIGNATURE_LENGTH) {
    return "invalid";
  }
  try {
    const publicKey = didToPublicKey(signer);
    if (ed25519.Point.fromBytes(publicKey, false).isSmallOrder()) {
      return "invalid";
    }
    return ed25519.verify(signature, message, publicKey, { zip215: false }) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/** A fresh 32-byte Ed25519 secret key (RFC 8032 seed). */
export function generateSecretKey(): Uint8Array {
  return ed25519.utils.randomSecretKey();
}

/** Keeps the secret key in memory. For tests and the development key file only. */
export function memoryKeyProvider(secretKey: Uint8Array): KeyProvider {
  const did = publicKeyToDid(ed25519.getPublicKey(secretKey));
  return {
    suite: SUITE_ID,
    profile: PROFILE_ID,
    getSigner: () => Promise.resolve(did),
    sign: (signedBytes) => Promise.resolve(ed25519.sign(signedBytes, secretKey)),
  };
}
