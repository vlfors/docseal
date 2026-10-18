import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAll, type SealFile } from "@docseal/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles } from "./files.js";

let dir: string;
const path = (...parts: string[]) => join(dir, ...parts);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const source = (files: SealFile[], name: string) => {
  const file = files.find((f) => f.path === name);
  if (!file || !("source" in file)) throw new Error(`no source for ${name}`);
  return file.source;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-files-"));
  await mkdir(path("docs", "sub"), { recursive: true });
  await writeFile(path("docs", "a.txt"), "document");
  await writeFile(path("docs", "sub", "b.txt"), "nested");
  await writeFile(path("secret.txt"), "private!");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("collectFiles", () => {
  it("collects files and directories and reads them", async () => {
    const files = await collectFiles([path("docs"), path("secret.txt")]);
    expect(files.map((f) => f.path).sort()).toEqual(["a.txt", "secret.txt", "sub/b.txt"]);
    expect(text(await readAll(source(files, "sub/b.txt")))).toBe("nested");
  });

  // Each case replaces something between collecting and reading, as a concurrent process could.
  const replacements: [string, (files: SealFile[]) => Promise<string>][] = [
    [
      "a file replaced by a symlink to another file",
      async () => {
        await rm(path("docs", "a.txt"));
        await symlink(path("secret.txt"), path("docs", "a.txt"));
        return "a.txt";
      },
    ],
    [
      "a file replaced by another file of the same size",
      async () => {
        await writeFile(path("docs", "other.txt"), "replaced");
        await rename(path("docs", "other.txt"), path("docs", "a.txt"));
        return "a.txt";
      },
    ],
    [
      "a directory replaced by a symlink to another directory",
      async () => {
        await mkdir(path("elsewhere"));
        await writeFile(path("elsewhere", "b.txt"), "foreign");
        await rename(path("docs", "sub"), path("old-sub"));
        await symlink(path("elsewhere"), path("docs", "sub"));
        return "sub/b.txt";
      },
    ],
    [
      "a file that grew",
      async () => {
        await appendFile(path("docs", "a.txt"), "+more");
        return "a.txt";
      },
    ],
  ];

  it.each(replacements)("refuses to read %s", async (_, replace) => {
    const files = await collectFiles([path("docs")]);
    const name = await replace(files);
    await expect(readAll(source(files, name))).rejects.toThrow(/changed while it was being read|Cannot read/);
  });

  it("refuses symlinks and special files when collecting", async () => {
    await symlink(path("secret.txt"), path("link.txt"));
    await expect(collectFiles([path("link.txt")])).rejects.toThrow("symbolic link");
    await symlink(path("secret.txt"), path("docs", "sub", "link.txt"));
    await expect(collectFiles([path("docs")])).rejects.toThrow("does not follow links");
    await expect(collectFiles([path("missing")])).rejects.toThrow("Cannot read");
  });
});
