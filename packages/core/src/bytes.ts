import { sha256 } from "@noble/hashes/sha2.js";

export const HASH_LENGTH = 32;

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** SHA-256 over the concatenation of `parts`. */
export function hash(...parts: Uint8Array[]): Uint8Array {
  const h = sha256.create();
  for (const part of parts) {
    h.update(part);
  }
  return h.digest();
}

export interface StreamDigest {
  digest: Uint8Array;
  size: number;
}

/** An incremental SHA-256, as returned by `sha256.create()` or wrapped around a native one. */
export interface IncrementalHash {
  update(chunk: Uint8Array): void;
  digest(): Uint8Array;
}

/**
 * Creates SHA-256 instances for hashing documents. The default is portable JavaScript;
 * an application may pass a native implementation (Node's `crypto`), which is several
 * times faster on large files. JSON documents always use the default.
 */
export type Sha256Factory = () => IncrementalHash;

export const portableSha256: Sha256Factory = () => sha256.create();

const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** Throws unless `factory` computes SHA-256 correctly (FIPS 180-2 "abc", fed in two updates). */
export function checkSha256(factory: Sha256Factory): void {
  const h = factory();
  h.update(utf8("a"));
  h.update(utf8("bc"));
  const digest = Array.from(h.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== ABC_SHA256) {
    throw new Error("The SHA-256 implementation gives wrong results");
  }
}

/** Hashes chunk by chunk, so arbitrarily large files never sit in memory at once. */
export async function hashStream(stream: AsyncIterable<Uint8Array>, sha: Sha256Factory = portableSha256): Promise<StreamDigest> {
  const h = sha();
  let size = 0;
  for await (const chunk of stream) {
    h.update(chunk);
    size += chunk.length;
  }
  return { digest: h.digest(), size };
}

/** Lexicographic byte order. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return a.length - b.length;
}

/** Equality of public values; not constant-time. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0;
}
