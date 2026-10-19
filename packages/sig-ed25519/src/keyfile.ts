/**
 * Development key file (FORMAT-v0.1 §Local key file): an Ed25519 seed encrypted with a
 * passphrase. Production keys belong in an HSM, KMS, or hardware token.
 */
import { fromBase64url, fromHex, jcs, parseJson, toBase64url, toHex, utf8 } from "@docseal/core";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { SUITE_ID, publicKeyToDid } from "./index.js";

export interface KeyFile {
  type: "docseal-key";
  version: 1;
  suite: typeof SUITE_ID;
  publicKey: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "xchacha20-poly1305"; nonce: string };
  ciphertext: string;
}

export class KeyFileError extends Error {
  override readonly name = "KeyFileError";
}

/** scrypt cost: 2^17 (128 MiB, about a second). Lower values are accepted only for tests. */
export const DEFAULT_SCRYPT_N = 2 ** 17;
const MIN_SCRYPT_N = 2 ** 10;
const MAX_SCRYPT_N = 2 ** 20;
const SEED_LENGTH = 32;

export interface KeyFileProgress {
  /** Called as scrypt runs, with the share done from 0 to 1. */
  onProgress?: (progress: number) => void;
}

export interface CreateKeyFileOptions extends KeyFileProgress {
  scryptN?: number;
  randomBytes?: (length: number) => Uint8Array;
}

export async function createKeyFile(
  seed: Uint8Array,
  passphrase: string,
  options: CreateKeyFileOptions = {},
): Promise<KeyFile> {
  if (seed.length !== SEED_LENGTH) {
    throw new KeyFileError("An Ed25519 seed is 32 bytes");
  }
  if (passphrase.length === 0) {
    throw new KeyFileError("The passphrase must not be empty");
  }
  const random = options.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const N = options.scryptN ?? DEFAULT_SCRYPT_N;
  checkCost(N);
  const header: Omit<KeyFile, "ciphertext"> = {
    type: "docseal-key",
    version: 1,
    suite: SUITE_ID,
    publicKey: publicKeyToDid(ed25519.getPublicKey(seed)),
    kdf: { name: "scrypt", N, r: 8, p: 1, salt: toHex(random(16)) },
    cipher: { name: "xchacha20-poly1305", nonce: toHex(random(24)) },
  };
  const key = await deriveKey(passphrase, header.kdf, options.onProgress);
  const ciphertext = xchacha20poly1305(key, fromHex(header.cipher.nonce), jcs(header)).encrypt(seed);
  key.fill(0);
  return { ...header, ciphertext: toBase64url(ciphertext) };
}

/** Decrypts the seed. Every header field is authenticated, so none can be swapped. */
export async function openKeyFile(bytes: Uint8Array, passphrase: string, options: KeyFileProgress = {}): Promise<{ seed: Uint8Array; did: string }> {
  const file = parseKeyFile(bytes);
  const { ciphertext, ...header } = file;
  const key = await deriveKey(passphrase, file.kdf, options.onProgress);
  let seed: Uint8Array;
  try {
    seed = xchacha20poly1305(key, fromHex(file.cipher.nonce), jcs(header)).decrypt(fromBase64url(ciphertext));
  } catch {
    throw new KeyFileError("Wrong passphrase or corrupted key file");
  } finally {
    key.fill(0);
  }
  const did = publicKeyToDid(ed25519.getPublicKey(seed));
  if (did !== file.publicKey) {
    throw new KeyFileError("Key file public key does not match the decrypted key");
  }
  return { seed, did };
}

/** Reads the public key without the passphrase. */
export function keyFilePublicKey(bytes: Uint8Array): string {
  return parseKeyFile(bytes).publicKey;
}

function parseKeyFile(bytes: Uint8Array): KeyFile {
  let value: unknown;
  try {
    value = parseJson(bytes);
  } catch {
    throw new KeyFileError("Key file is not valid JSON");
  }
  const file = value as Partial<KeyFile> | null;
  if (file?.type !== "docseal-key" || file.version !== 1 || file.suite !== SUITE_ID) {
    throw new KeyFileError("Not a DocSeal Ed25519 key file (version 1)");
  }
  const { kdf, cipher } = file;
  if (
    typeof file.publicKey !== "string" ||
    typeof file.ciphertext !== "string" ||
    kdf?.name !== "scrypt" ||
    kdf.r !== 8 ||
    kdf.p !== 1 ||
    !/^[0-9a-f]{32}$/.test(kdf.salt) ||
    cipher?.name !== "xchacha20-poly1305" ||
    !/^[0-9a-f]{48}$/.test(cipher.nonce)
  ) {
    throw new KeyFileError("Key file has unsupported or malformed parameters");
  }
  checkCost(kdf.N);
  return file as KeyFile;
}

function checkCost(N: number): void {
  // A power of two within bounds: a tampered file must not make us allocate gigabytes.
  if (!Number.isSafeInteger(N) || N < MIN_SCRYPT_N || N > MAX_SCRYPT_N || (N & (N - 1)) !== 0) {
    throw new KeyFileError(`scrypt N must be a power of two between 2^10 and 2^20`);
  }
}

function deriveKey(passphrase: string, kdf: KeyFile["kdf"], onProgress?: (progress: number) => void): Promise<Uint8Array> {
  return scryptAsync(utf8(passphrase.normalize("NFC")), fromHex(kdf.salt), {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: 32,
    ...(onProgress && { onProgress }),
  });
}
