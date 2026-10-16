import { utf8 } from "@docseal/core";
import { describe, expect, it } from "vitest";
import { generateSecretKey, memoryKeyProvider } from "./index.js";
import { KeyFileError, createKeyFile, keyFilePublicKey, openKeyFile } from "./keyfile.js";

const FAST = { scryptN: 2 ** 10 };
const encode = (value: unknown) => utf8(JSON.stringify(value));

describe("key file", () => {
  it("round-trips the seed and exposes the public key without the passphrase", async () => {
    const seed = generateSecretKey();
    const file = await createKeyFile(seed, "correct horse", FAST);
    const did = await memoryKeyProvider(seed).getSigner();
    expect(file.publicKey).toBe(did);
    expect(keyFilePublicKey(encode(file))).toBe(did);
    await expect(openKeyFile(encode(file), "correct horse")).resolves.toEqual({ seed, did });
  });

  it("does not store the seed in the clear", async () => {
    const seed = new Uint8Array(32).fill(7);
    const text = JSON.stringify(await createKeyFile(seed, "pw", FAST));
    expect(text).not.toContain("07".repeat(8));
  });

  it("rejects a wrong passphrase", async () => {
    const file = await createKeyFile(generateSecretKey(), "right", FAST);
    await expect(openKeyFile(encode(file), "wrong")).rejects.toThrow(/Wrong passphrase/);
  });

  it("authenticates the header: swapping the public key or KDF parameters fails", async () => {
    const file = await createKeyFile(generateSecretKey(), "pw", FAST);
    const other = await createKeyFile(generateSecretKey(), "pw", FAST);
    await expect(openKeyFile(encode({ ...file, publicKey: other.publicKey }), "pw")).rejects.toThrow(KeyFileError);
    await expect(openKeyFile(encode({ ...file, kdf: { ...file.kdf, N: 2 ** 11 } }), "pw")).rejects.toThrow(KeyFileError);
  });

  it("refuses unreasonable scrypt costs before deriving anything", async () => {
    const file = await createKeyFile(generateSecretKey(), "pw", FAST);
    for (const N of [2 ** 30, 1000, 2 ** 9]) {
      await expect(openKeyFile(encode({ ...file, kdf: { ...file.kdf, N } }), "pw")).rejects.toThrow(/power of two/);
    }
  });

  it("rejects malformed files and empty passphrases", async () => {
    await expect(openKeyFile(utf8("{}"), "pw")).rejects.toThrow(KeyFileError);
    await expect(openKeyFile(utf8("not json"), "pw")).rejects.toThrow(KeyFileError);
    await expect(createKeyFile(generateSecretKey(), "", FAST)).rejects.toThrow(/empty/);
  });

  it("treats NFC and NFD spellings of the passphrase as the same", async () => {
    const file = await createKeyFile(generateSecretKey(), "paßwort café", FAST);
    await expect(openKeyFile(encode(file), "paßwort café")).resolves.toBeDefined();
  });
});
