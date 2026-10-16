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

/** Hashes a stream chunk by chunk, so arbitrarily large files never sit in memory at once. */
export async function hashStream(stream: ReadableStream<Uint8Array>): Promise<StreamDigest> {
  const h = sha256.create();
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
