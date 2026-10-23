import { describe, expect, it } from "vitest";
import { sanitize } from "../../../../packages/node/src/sanitize";
import { clip, hasUnsafe, shortId, visibleParts } from "./text";

describe("visibleParts", () => {
  it("leaves ordinary text, including right-to-left letters, as one part", () => {
    for (const text of ["Договор №17.pdf", "emoji 😀.txt", "שלום.txt", "a b"]) {
      expect(visibleParts(text)).toEqual([{ text, unsafe: false }]);
      expect(hasUnsafe(text)).toBe(false);
    }
  });

  it("marks a bidirectional override so a name cannot disguise its extension", () => {
    expect(visibleParts("invoice\u202Etxt.exe")).toEqual([
      { text: "invoice", unsafe: false },
      { text: "\u202E", unsafe: true, code: "U+202E" },
      { text: "txt.exe", unsafe: false },
    ]);
    expect(hasUnsafe("invoice\u202Etxt.exe")).toBe(true);
  });

  it("marks consecutive and trailing characters one by one", () => {
    expect(visibleParts("\u0000\u001b[31m\u200B")).toEqual([
      { text: "\u0000", unsafe: true, code: "U+0000" },
      { text: "\u001b", unsafe: true, code: "U+001B" },
      { text: "[31m", unsafe: false },
      { text: "\u200B", unsafe: true, code: "U+200B" },
    ]);
    expect(visibleParts("")).toEqual([]);
  });

  it("marks exactly the characters the CLI escapes", () => {
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) {
        continue;
      }
      const char = String.fromCharCode(code);
      expect(hasUnsafe(char), `U+${code.toString(16)}`).toBe(sanitize(char) !== char);
    }
  });
});

describe("shortId and clip", () => {
  it("shorten long values and keep short ones", () => {
    expect(shortId("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK")).toBe("did:key:z6MkhaXgBZDv…ta2doK");
    expect(shortId("short")).toBe("short");
    expect(clip("x".repeat(250))).toEqual({ text: `${"x".repeat(200)}…`, length: 250 });
    expect(clip("abc")).toEqual({ text: "abc" });
  });
});
