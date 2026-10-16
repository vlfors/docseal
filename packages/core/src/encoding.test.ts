import { describe, expect, it } from "vitest";
import { EncodingError, fromBase64url, fromHex, toBase64url, toHex } from "./encoding.js";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("hex", () => {
  it("round-trips", () => {
    const input = bytes(0x00, 0x0f, 0xa0, 0xff);
    expect(toHex(input)).toBe("000fa0ff");
    expect(fromHex("000fa0ff")).toEqual(input);
  });

  it.each(["ABCD", "abc", "0g", " 00", "00\n"])("rejects %j", (text) => {
    expect(() => fromHex(text)).toThrow(EncodingError);
  });

  it("enforces the expected length", () => {
    expect(() => fromHex("00".repeat(31), 32)).toThrow(EncodingError);
    expect(fromHex("00".repeat(32), 32)).toHaveLength(32);
  });
});

describe("base64url", () => {
  // RFC 4648 §10 test vectors, converted to the URL-safe alphabet without padding.
  it.each([
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ])("encodes %j as %j", (plain, encoded) => {
    const input = new TextEncoder().encode(plain);
    expect(toBase64url(input)).toBe(encoded);
    expect(fromBase64url(encoded)).toEqual(input);
  });

  it("uses the URL-safe alphabet", () => {
    expect(toBase64url(bytes(0xfb, 0xff))).toBe("-_8");
  });

  it.each(["Zg==", "+/8", "Z", "Zh", "Zm9 v", "Zm9v\n"])("rejects %j", (text) => {
    expect(() => fromBase64url(text)).toThrow(EncodingError);
  });

  it("round-trips every byte value", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (let length = 0; length <= all.length; length += 17) {
      const slice = all.subarray(0, length);
      expect(fromBase64url(toBase64url(slice))).toEqual(slice);
    }
  });
});
