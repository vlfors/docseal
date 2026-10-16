/** The OpenTimestamps proof format against the reference client's example proofs. */
import { hash, toHex } from "@docseal/core";
import {
  HEADER_MAGIC,
  OtsError,
  attestations,
  mergeTimestamps,
  parseDetached,
  parseTimestamp,
  serializeDetached,
  type Timestamp,
} from "@docseal/anchor-ots";
import { describe, expect, it } from "vitest";
import { block358391, fixture } from "./helpers.js";

const EXAMPLES = [
  "bad-stamp",
  "different-blockchains",
  "hello-world",
  "incomplete",
  "known-and-unknown-notary",
  "two-calendars",
  "unknown-notary",
];

describe("parseDetached", () => {
  it.each(EXAMPLES)("parses and re-serializes %s byte for byte", (name) => {
    const bytes = fixture(`${name}.txt.ots`);
    expect(toHex(serializeDetached(parseDetached(bytes)))).toBe(toHex(bytes));
  });

  it.each(EXAMPLES)("commits %s to the SHA-256 of the file", (name) => {
    expect(parseDetached(fixture(`${name}.txt.ots`)).timestamp.msg).toEqual(hash(fixture(`${name}.txt`)));
  });

  it("reaches the merkle root of block 358391 in hello-world, through RIPEMD-160", () => {
    const found = attestations(parseDetached(fixture("hello-world.txt.ots")).timestamp);
    const bitcoin = found.filter(({ attestation }) => attestation.kind === "bitcoin");
    expect(bitcoin).toHaveLength(1);
    expect(bitcoin[0]?.attestation).toEqual({ kind: "bitcoin", height: 358391 });
    expect(toHex(bitcoin[0]?.msg ?? new Uint8Array())).toBe(toHex(block358391().merkleRoot));
  });

  it("finds pending and unknown attestations", () => {
    const kinds = (name: string) =>
      attestations(parseDetached(fixture(`${name}.txt.ots`)).timestamp).map(({ attestation }) => attestation.kind);
    expect(kinds("incomplete")).toEqual(["pending"]);
    expect(kinds("two-calendars")).toEqual(["pending", "pending"]);
    expect(kinds("unknown-notary")).toEqual(["unknown"]);
  });

  describe("rejects malformed proofs", () => {
    const valid = fixture("incomplete.txt.ots");

    it.each([
      ["empty input", new Uint8Array()],
      ["wrong magic", Uint8Array.from([1, ...valid.subarray(1)])],
      ["truncated", valid.subarray(0, valid.length - 1)],
      ["trailing data", Uint8Array.from([...valid, 0])],
      ["unknown version", Uint8Array.from([...HEADER_MAGIC, 2, ...valid.subarray(HEADER_MAGIC.length + 1)])],
      ["SHA-1 file digest", Uint8Array.from([...HEADER_MAGIC, 1, 0x02, ...new Uint8Array(20), 0x00])],
    ])("%s", (_, bytes) => {
      expect(() => parseDetached(bytes)).toThrow(OtsError);
    });

    it("rejects an unknown operation", () => {
      expect(() => parseTimestamp(Uint8Array.of(0xaa), new Uint8Array(32))).toThrow(/Unknown operation/);
    });

    it("rejects an append argument longer than 4096 bytes", () => {
      const body = Uint8Array.from([0xf0, 0x81, 0x20, ...new Uint8Array(4097)]);
      expect(() => parseTimestamp(body, new Uint8Array(32))).toThrow(OtsError);
    });

    it("rejects nesting deeper than 256 operations", () => {
      const body = Uint8Array.from([...new Array<number>(300).fill(0x08), 0x00, ...new Uint8Array(8), 0x00]);
      expect(() => parseTimestamp(body, new Uint8Array(32))).toThrow(/deeply/);
    });

    it("rejects calendar URIs with forbidden characters", () => {
      const uri = new TextEncoder().encode("https://evil?x=1");
      const pendingTag = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];
      const body = Uint8Array.from([0x00, ...pendingTag, uri.length + 1, uri.length, ...uri]);
      expect(() => parseTimestamp(body, new Uint8Array(32))).toThrow(/forbidden/);
    });

    it("never throws anything but OtsError on corrupted proofs", () => {
      const bytes = fixture("hello-world.txt.ots");
      for (let i = 0; i < bytes.length; i++) {
        const corrupted = bytes.slice();
        corrupted[i] = (corrupted[i] ?? 0) ^ 0x5a;
        try {
          parseDetached(corrupted);
        } catch (error) {
          expect(error).toBeInstanceOf(OtsError);
        }
      }
    });
  });

  it("ignores attestations reached through SHA-1", () => {
    // sha1, then a Bitcoin attestation: parsed, but never offered for verification.
    const bitcoinTag = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
    const timestamp = parseTimestamp(Uint8Array.from([0x02, 0x00, ...bitcoinTag, 1, 1]), new Uint8Array(32));
    expect(timestamp.ops).toHaveLength(1);
    expect(attestations(timestamp)).toEqual([]);
  });
});

describe("mergeTimestamps", () => {
  it("combines branches and de-duplicates attestations", () => {
    const msg = new Uint8Array(32);
    const a: Timestamp = { msg, attestations: [{ kind: "pending", uri: "https://a" }], ops: [] };
    const b: Timestamp = {
      msg,
      attestations: [{ kind: "pending", uri: "https://a" }, { kind: "pending", uri: "https://b" }],
      ops: [],
    };
    mergeTimestamps(a, b);
    expect(a.attestations).toHaveLength(2);
  });

  it("refuses timestamps for different messages", () => {
    const a: Timestamp = { msg: new Uint8Array(32), attestations: [], ops: [] };
    const b: Timestamp = { msg: new Uint8Array(32).fill(1), attestations: [], ops: [] };
    expect(() => {
      mergeTimestamps(a, b);
    }).toThrow(OtsError);
  });
});
