/**
 * Strict binary encodings used in DocSeal JSON documents (FORMAT-v0.1 §Conventions).
 *
 * Decoders accept exactly one textual form per byte string, so that a value can never
 * be re-encoded differently and still pass verification.
 */

export class EncodingError extends Error {
  override readonly name = "EncodingError";
}

const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/;

/** Encodes bytes as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Decodes lowercase hex. Uppercase, odd length, and any other character are rejected. */
export function fromHex(hex: string, expectedLength?: number): Uint8Array {
  if (!HEX_PATTERN.test(hex)) {
    throw new EncodingError("Expected lowercase hex with an even number of digits");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  checkLength(bytes, expectedLength);
  return bytes;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/** Encodes bytes as base64url without padding (RFC 4648 §5). */
export function toBase64url(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0x3fff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += sextet(buffer >> bits);
    }
  }
  if (bits > 0) {
    out += sextet(buffer << (6 - bits));
  }
  return out;
}

/**
 * Decodes unpadded base64url. Padding, the standard base64 alphabet, whitespace,
 * impossible lengths, and non-zero trailing bits are rejected.
 */
export function fromBase64url(text: string, expectedLength?: number): Uint8Array {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
    throw new EncodingError("Expected unpadded base64url");
  }
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of text) {
    buffer = ((buffer << 6) | BASE64URL_ALPHABET.indexOf(char)) & 0x3fff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) {
    throw new EncodingError("Non-canonical base64url: trailing bits must be zero");
  }
  checkLength(bytes, expectedLength);
  return bytes;
}

function sextet(n: number): string {
  return BASE64URL_ALPHABET.charAt(n & 0x3f);
}

function checkLength(bytes: Uint8Array, expectedLength: number | undefined): void {
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new EncodingError(`Expected ${String(expectedLength)} bytes, got ${String(bytes.length)}`);
  }
}
