/** The OpenTimestamps proof format against the reference client's example proofs. */
import { hash, toHex, utf8 } from "@docseal/core";
import {
  HEADER_MAGIC,
  OtsError,
  applyOp,
  attestations,
  mergeTimestamps,
  parseDetached,
  parseTimestamp,
  serializeDetached,
  serializeTimestamp,
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

const UNKNOWN_TAG = [1, 2, 3, 4, 5, 6, 7, 8];

function varuint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

describe("OtsError", () => {
  it("is named", () => {
    expect(new OtsError("x").name).toBe("OtsError");
  });
});

describe("applyOp", () => {
  it("hexlifies to lowercase ASCII hex", () => {
    expect(applyOp({ kind: "hexlify" }, Uint8Array.of(0xab, 0x01))).toEqual(utf8("ab01"));
  });
});

describe("serializeTimestamp", () => {
  const msg = new Uint8Array(32);
  const leaf = (): Timestamp => ({ msg: new Uint8Array(), attestations: [{ kind: "pending", uri: "https://a" }], ops: [] });

  it("writes operations and attestations in canonical order, whatever their order in memory", () => {
    const ops: Timestamp["ops"] = [
      { op: { kind: "append", arg: Uint8Array.of(2) }, next: leaf() },
      { op: { kind: "sha256" }, next: leaf() },
      { op: { kind: "append", arg: Uint8Array.of(1) }, next: leaf() },
      { op: { kind: "prepend", arg: Uint8Array.of(1) }, next: leaf() },
    ];
    const atts: Timestamp["attestations"] = [
      { kind: "unknown", tag: Uint8Array.from(UNKNOWN_TAG), payload: Uint8Array.of(2) },
      { kind: "bitcoin", height: 2 },
      { kind: "unknown", tag: Uint8Array.from(UNKNOWN_TAG), payload: Uint8Array.of(1) },
      { kind: "bitcoin", height: 1 },
      { kind: "pending", uri: "https://b" },
      { kind: "pending", uri: "https://a" },
    ];
    const forward = serializeTimestamp({ msg, attestations: atts, ops });
    expect(serializeTimestamp({ msg, attestations: [...atts].reverse(), ops: [...ops].reverse() })).toEqual(forward);
    const parsed = parseTimestamp(forward, msg);
    expect(parsed.ops.map(({ op }) => ("arg" in op ? `${op.kind}:${String(op.arg[0])}` : op.kind))).toEqual(["sha256", "append:1", "append:2", "prepend:1"]);
    expect(parsed.attestations.map((a) => (a.kind === "bitcoin" ? a.height : a.kind === "pending" ? a.uri : String(a.payload[0])))).toEqual(["1", "2", 1, 2, "https://a", "https://b"]);
  });

  it("refuses an empty timestamp", () => {
    expect(() => serializeTimestamp({ msg, attestations: [], ops: [] })).toThrow("An empty timestamp cannot be serialized");
  });
});

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

    it("rejects a file digest other than SHA-256, even when 32 bytes follow", () => {
      const rest = valid.subarray(HEADER_MAGIC.length + 2);
      expect(() => parseDetached(Uint8Array.from([...HEADER_MAGIC, 1, 0x08, ...rest]))).not.toThrow();
      expect(() => parseDetached(Uint8Array.from([...HEADER_MAGIC, 1, 0x67, ...rest]))).toThrow("Only SHA-256 file digests are supported");
    });

    it("rejects an empty append argument, and accepts one of exactly 4096 bytes", () => {
      const attestation = [0x00, ...UNKNOWN_TAG, 0x00];
      expect(() => parseTimestamp(Uint8Array.from([0xf0, 0x00, ...attestation]), new Uint8Array())).toThrow("Byte string length out of range");
      expect(() => parseTimestamp(Uint8Array.from([0xf0, 0x80, 0x20, ...new Uint8Array(4096), ...attestation]), new Uint8Array())).not.toThrow();
    });

    it("limits an operation's result to 4096 bytes", () => {
      const attestation = [0x00, ...UNKNOWN_TAG, 0x00];
      const append = (length: number) => Uint8Array.from([0xf0, ...varuint(length), ...new Uint8Array(length), ...attestation]);
      expect(() => parseTimestamp(append(4064), new Uint8Array(32))).not.toThrow();
      expect(() => parseTimestamp(append(4065), new Uint8Array(32))).toThrow("Operation result is too long");
    });

    it("accepts nesting of exactly 256 operations", () => {
      const nested = (depth: number) => Uint8Array.from([...new Array<number>(depth).fill(0x08), 0x00, ...UNKNOWN_TAG, 0x00]);
      expect(() => parseTimestamp(nested(256), new Uint8Array(32))).not.toThrow();
      expect(() => parseTimestamp(nested(257), new Uint8Array(32))).toThrow("Proof is nested too deeply");
    });

    it("accepts exactly 10 000 nodes", () => {
      // The root plus one `reverse` node per branch, each ending in an unknown attestation.
      const branches = (count: number) => {
        const branch = [0xf2, 0x00, ...UNKNOWN_TAG, 0x00];
        const body: number[] = [];
        for (let i = 1; i < count; i++) body.push(0xff, ...branch);
        body.push(...branch);
        return Uint8Array.from(body);
      };
      expect(() => parseTimestamp(branches(9_999), new Uint8Array(32))).not.toThrow();
      expect(() => parseTimestamp(branches(10_000), new Uint8Array(32))).toThrow("Proof is too large");
    });

    it("limits the total size of all messages to 4 MiB", () => {
      // Grow the message to 4096 bytes, then branch into `reverse` nodes of 4096 bytes each.
      const grown = (count: number) => {
        const body: number[] = [0xf0, ...varuint(4064), ...new Uint8Array(4064)];
        const branch = [0xf2, 0x00, ...UNKNOWN_TAG, 0x00];
        for (let i = 1; i < count; i++) body.push(0xff, ...branch);
        body.push(...branch);
        return Uint8Array.from(body);
      };
      expect(() => parseTimestamp(grown(1000), new Uint8Array(32))).not.toThrow();
      expect(() => parseTimestamp(grown(1100), new Uint8Array(32))).toThrow("Proof is too large");
    });

    it("rejects an unknown operation", () => {
      expect(() => parseTimestamp(Uint8Array.of(0xaa), new Uint8Array(32))).toThrow(/Unknown operation/);
    });

    it("rejects an append argument longer than 4096 bytes", () => {
      const body = Uint8Array.from([0xf0, 0x81, 0x20, ...new Uint8Array(4097)]);
      expect(() => parseTimestamp(body, new Uint8Array(32))).toThrow("Byte string length out of range");
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

    it("refuses a small proof that would expand into a huge tree", () => {
      // hexlify to 64 bytes, then 20000 one-byte `reverse` branches, each ending in an unknown attestation.
      const branch = [0xf2, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 0x00];
      const body = [0xf3];
      for (let i = 0; i < 20_000; i++) body.push(0xff, ...branch);
      body.push(...branch);
      expect(() => parseTimestamp(Uint8Array.from(body), new Uint8Array(32))).toThrow(/too large/);
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

  it("merges branches with the same operation recursively", () => {
    const msg = new Uint8Array(32);
    const next = hash(msg);
    const a: Timestamp = { msg, attestations: [], ops: [{ op: { kind: "sha256" }, next: { msg: next, attestations: [{ kind: "pending", uri: "https://a" }], ops: [] } }] };
    const b: Timestamp = { msg, attestations: [], ops: [{ op: { kind: "sha256" }, next: { msg: next, attestations: [{ kind: "bitcoin", height: 1 }], ops: [] } }] };
    mergeTimestamps(a, b);
    expect(a.ops).toHaveLength(1);
    expect(a.ops[0]?.next.attestations).toEqual([{ kind: "pending", uri: "https://a" }, { kind: "bitcoin", height: 1 }]);
  });

  it("refuses timestamps for different messages", () => {
    const a: Timestamp = { msg: new Uint8Array(32), attestations: [], ops: [] };
    const b: Timestamp = { msg: new Uint8Array(32).fill(1), attestations: [], ops: [] };
    expect(() => {
      mergeTimestamps(a, b);
    }).toThrow(OtsError);
  });
});
