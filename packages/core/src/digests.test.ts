import { describe, expect, it } from "vitest";
import { hash, utf8 } from "./bytes.js";
import { jsonHash, sealDigest, signaturesSetHash, signedBytes } from "./digests.js";
import { FormatError } from "./errors.js";

const a = hash(utf8("a"));
const b = hash(utf8("b"));

describe("signedBytes", () => {
  it("is the domain prefix followed by H(JCS(protected))", () => {
    const header = { b: 1, a: "x" };
    const bytes = signedBytes(header);
    expect(new TextDecoder().decode(bytes.subarray(0, 21))).toBe("DocSeal/v1/signature\0");
    expect(bytes.subarray(21)).toEqual(hash(utf8('{"a":"x","b":1}')));
  });

  it("changes with any field", () => {
    expect(signedBytes({ role: "author" })).not.toEqual(signedBytes({ role: "witness" }));
  });
});

describe("signaturesSetHash", () => {
  it("does not depend on order", () => {
    expect(signaturesSetHash([a, b])).toEqual(signaturesSetHash([b, a]));
  });

  it("differs from the plain hash and between sets", () => {
    expect(signaturesSetHash([a])).not.toEqual(signaturesSetHash([a, b]));
    expect(signaturesSetHash([a])).not.toEqual(hash(a));
  });

  it("rejects duplicate envelopes", () => {
    expect(() => signaturesSetHash([a, b, a])).toThrow(FormatError);
  });
});

describe("sealDigest", () => {
  it("binds both the statement and the signature set", () => {
    const set = signaturesSetHash([a]);
    expect(sealDigest(a, set)).not.toEqual(sealDigest(b, set));
    expect(sealDigest(a, set)).not.toEqual(sealDigest(a, signaturesSetHash([b])));
  });
});

describe("jsonHash", () => {
  it("ignores key order", () => {
    expect(jsonHash({ x: 1, y: 2 })).toEqual(jsonHash({ y: 2, x: 1 }));
  });
});
