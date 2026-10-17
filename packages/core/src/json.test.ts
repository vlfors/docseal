import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { FormatError } from "./errors.js";
import { jcs, parseJson } from "./json.js";

const parse = (text: string) => parseJson(utf8(text));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("parseJson", () => {
  it("parses ordinary documents like JSON.parse", () => {
    const text = '{"a":[1,-2.5e3,true,false,null,"x\\u00e9\\n"],"b":{}}';
    expect(parse(text)).toEqual(JSON.parse(text));
  });

  it("agrees with JSON.parse on arbitrary JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = JSON.stringify(value);
        expect(parse(text)).toEqual(JSON.parse(text));
      }),
    );
  });

  it.each([
    ['{"a":1,"a":2}', "duplicate key"],
    ['{"a":{"b":1,"b":1}}', "nested duplicate key"],
    ['"\\ud800"', "lone surrogate"],
    ['"a\u0001"', "raw control character"],
    ["1e400", "non-finite number"],
    ["[1,]", "trailing comma"],
    ["01", "leading zero"],
    ["{'a':1}", "single quotes"],
    ["NaN", "NaN"],
    ["[1] [2]", "trailing data"],
    ["", "empty input"],
    ['"\\x41"', "invalid escape"],
    ["[".repeat(100) + "]".repeat(100), "deep nesting"],
  ])("rejects %j (%s)", (text) => {
    expect(() => parse(text)).toThrow(FormatError);
  });

  it.each([
    ["arrays", (levels: number) => `${"[".repeat(levels)}1${"]".repeat(levels)}`],
    ["objects", (levels: number) => `${'{"a":'.repeat(levels)}1${"}".repeat(levels)}`],
    ["both", (levels: number) => `${'[{"a":'.repeat(levels / 2)}1${"}]".repeat(levels / 2)}`],
  ])("accepts values nested 64 levels deep in %s, and rejects 66", (_, nested) => {
    expect(() => parse(nested(64))).not.toThrow();
    expect(() => parse(nested(66))).toThrow("nesting is too deep");
  });

  it("allows whitespace around every token", () => {
    expect(parse(' \t\n\r{ "a" : [ 1 , { } , [ ] ] , "b" : "c" } \n')).toEqual({ a: [1, {}, []], b: "c" });
  });

  it("rejects a byte-order mark and invalid UTF-8", () => {
    expect(() => parseJson(Uint8Array.of(0xef, 0xbb, 0xbf, 0x31))).toThrow(FormatError);
    expect(() => parseJson(Uint8Array.of(0x22, 0xff, 0x22))).toThrow(FormatError);
  });

  it("treats __proto__ as an ordinary key", () => {
    const value = parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(decode(jcs(value))).toBe('{"__proto__":{"polluted":true}}');
  });
});

describe("jcs", () => {
  // RFC 8785 §3.2.2 and §3.2.3 examples.
  it("sorts keys by UTF-16 code units and serializes numbers like ECMAScript", () => {
    const value = { "\u20ac": "Euro", "\r": "CR", "\ufb33": "Hebrew", "1": "One", "\ud83d\ude00": "Smiley", "\u0080": "Ctrl", "\u00f6": "Latin" };
    expect(decode(jcs(value))).toBe(
      '{"\\r":"CR","1":"One","\u0080":"Ctrl","\u00f6":"Latin","\u20ac":"Euro","\ud83d\ude00":"Smiley","\ufb33":"Hebrew"}',
    );
    expect(decode(jcs([1e21, 1e-7, 0.000001, -0, Number("333333333.33333329")]))).toBe("[1e+21,1e-7,0.000001,0,333333333.3333333]");
  });

  it("is independent of formatting and key order", () => {
    expect(jcs(parse('{ "b": [1, 2],\n "a": "x" }'))).toEqual(jcs({ a: "x", b: [1, 2] }));
  });
});
