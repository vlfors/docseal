import { fromHex, toHex } from "@docseal/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  PROFILE_ID,
  didToPublicKey,
  ed25519Suite,
  generateSecretKey,
  memoryKeyProvider,
  publicKeyToDid,
} from "./index.js";

// RFC 8032 §7.1, TEST 1.
const SECRET = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const PUBLIC = fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
const SIGNATURE = fromHex(
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
);
const EMPTY = new Uint8Array();

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function le32(value: bigint): Uint8Array {
  return fromHex(value.toString(16).padStart(64, "0")).reverse();
}

function fromLe(bytes: Uint8Array): bigint {
  return BigInt(`0x${toHex(bytes.slice().reverse())}`);
}

describe("did:key", () => {
  it("round-trips an Ed25519 public key with the z6Mk prefix", () => {
    const did = publicKeyToDid(PUBLIC);
    expect(did).toMatch(/^did:key:z6Mk/);
    expect(toHex(didToPublicKey(did))).toBe(toHex(PUBLIC));
  });

  it.each(["did:web:example.com", "did:key:z", "did:key:zQ3s", "did:key:u7QE"])("rejects %j", (did) => {
    expect(() => didToPublicKey(did)).toThrow();
  });
});

describe("ed25519Suite", () => {
  const suite = ed25519Suite();
  const did = publicKeyToDid(PUBLIC);

  it("accepts the RFC 8032 test vector", async () => {
    await expect(suite.verify(did, EMPTY, SIGNATURE, PROFILE_ID)).resolves.toBe("valid");
  });

  it("produces the RFC 8032 signature", async () => {
    const provider = memoryKeyProvider(SECRET);
    await expect(provider.getSigner()).resolves.toBe(did);
    expect(toHex(await provider.sign(EMPTY))).toBe(toHex(SIGNATURE));
  });

  it("rejects a modified message or signature", async () => {
    await expect(suite.verify(did, Uint8Array.of(0), SIGNATURE, PROFILE_ID)).resolves.toBe("invalid");
    const tampered = SIGNATURE.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(suite.verify(did, EMPTY, tampered, PROFILE_ID)).resolves.toBe("invalid");
  });

  it("rejects a non-canonical S (signature malleability)", async () => {
    // Adding the group order L to S yields an equivalent but non-canonical signature.
    const signature = new Uint8Array([...SIGNATURE.slice(0, 32), ...le32(fromLe(SIGNATURE.slice(32)) + L)]);
    await expect(suite.verify(did, EMPTY, signature, PROFILE_ID)).resolves.toBe("invalid");
  });

  it("rejects small-order public keys, for which a single signature verifies any message", async () => {
    // A = identity, R = identity, S = 0 satisfies the cofactored equation for every message.
    const identity = le32(1n);
    const universal = new Uint8Array([...identity, ...le32(0n)]);
    for (const message of [EMPTY, Uint8Array.of(42)]) {
      await expect(suite.verify(publicKeyToDid(identity), message, universal, PROFILE_ID)).resolves.toBe("invalid");
    }
  });

  it("rejects non-canonical point encodings that ZIP-215 would accept", async () => {
    // Signature with nonce r = 0, so R is the identity point (y = 1). Its canonical encoding
    // is y = 1; y = p + 1 encodes the same point non-canonically.
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(SECRET);
    const sign = (rEncoding: Uint8Array) => {
      const k = fromLe(sha512(new Uint8Array([...rEncoding, ...pointBytes]))) % L;
      return new Uint8Array([...rEncoding, ...le32((k * scalar) % L)]);
    };
    await expect(suite.verify(did, EMPTY, sign(le32(1n)), PROFILE_ID)).resolves.toBe("valid");
    await expect(suite.verify(did, EMPTY, sign(le32(P + 1n)), PROFILE_ID)).resolves.toBe("invalid");
  });

  it("rejects wrong lengths and malformed signers", async () => {
    await expect(suite.verify(did, EMPTY, SIGNATURE.slice(1), PROFILE_ID)).resolves.toBe("invalid");
    await expect(suite.verify("did:web:example.com", EMPTY, SIGNATURE, PROFILE_ID)).resolves.toBe("invalid");
  });

  it("reports other profiles as unsupported", async () => {
    await expect(suite.verify(did, EMPTY, SIGNATURE, "docseal-ed25519-v2")).resolves.toBe("unsupported");
  });

  it("signs and verifies with a fresh key", async () => {
    const provider = memoryKeyProvider(generateSecretKey());
    const message = Uint8Array.of(1, 2, 3);
    const signature = await provider.sign(message);
    await expect(suite.verify(await provider.getSigner(), message, signature, PROFILE_ID)).resolves.toBe("valid");
  });
});
