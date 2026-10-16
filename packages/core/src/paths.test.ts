import { describe, expect, it } from "vitest";
import { FormatError } from "./errors.js";
import { checkPathCollisions, comparePaths, normalizePath, validatePath } from "./paths.js";

describe("validatePath", () => {
  it.each(["a.pdf", "dir/sub/file.txt", "Договор №17.pdf", "emoji 😀.txt", ".hidden", "a..b"])("accepts %j", (path) => {
    expect(() => {
      validatePath(path);
    }).not.toThrow();
  });

  it.each([
    "",
    "/abs",
    "trailing/",
    "a//b",
    "../escape",
    "a/../b",
    "./a",
    "a\\b",
    "nul\u0000",
    "tab\t",
    "del\u007f",
    "é", // NFD
    "\ud800",
    "x".repeat(1025),
  ])("rejects %j", (path) => {
    expect(() => {
      validatePath(path);
    }).toThrow(FormatError);
  });

  it("normalizes to NFC when sealing", () => {
    expect(normalizePath("é.txt")).toBe("é.txt");
  });
});

describe("comparePaths", () => {
  it("orders by UTF-8 bytes, which differs from UTF-16 order above U+FFFF", () => {
    // U+FF61 sorts after U+1F600 in UTF-16 (0xFF61 > 0xD83D) but before it in UTF-8.
    const paths = ["\u{1f600}", "｡", "b", "a/z", "a"];
    expect([...paths].sort(comparePaths)).toEqual(["a", "a/z", "b", "｡", "\u{1f600}"]);
  });
});

describe("checkPathCollisions", () => {
  it.each([
    [["a.txt", "a.txt"]],
    [["Readme.md", "README.md"]],
    [["a", "a/b"]],
    [["a/b", "A"]],
  ])("rejects %j", (paths) => {
    expect(() => {
      checkPathCollisions(paths);
    }).toThrow(FormatError);
  });

  it("accepts distinct paths", () => {
    expect(() => {
      checkPathCollisions(["a/b", "a/c", "ab"]);
    }).not.toThrow();
  });
});
