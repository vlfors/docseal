/**
 * No source file may hold an invisible or reordering character as is (Trojan Source,
 * CVE-2021-42574): code would read one way and run another. Tests that need such characters
 * write them as escapes (`\u202E`); text meant for people names them (`<U+202E>`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
const TEXT = /\.(ts|js|mjs|svelte|json|md|yml|yaml|py|css|html|sh|txt)$/;

describe("source text", () => {
  it("has no invisible or bidirectional characters", () => {
    const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((file) => TEXT.test(file) && !file.startsWith("spec/vectors/"));
    const found = files.flatMap((file) => {
      const lines = readFileSync(new URL(file, ROOT), "utf8").split("\n");
      return lines.flatMap((line, i) => (INVISIBLE.test(line) ? [`${file}:${String(i + 1)}`] : []));
    });
    expect(found).toEqual([]);
  });
});
