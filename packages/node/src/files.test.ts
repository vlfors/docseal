import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAll, type SealFile } from "@docseal/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles, createOutput } from "./files.js";
import { OutputExistsError } from "./errors.js";

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

describe("createOutput", () => {
  it("never replaces a file that appears while a new one is written", async () => {
    const output = await createOutput(path("new.dseal"), { overwrite: false });
    await output.write(new TextEncoder().encode("ours"));
    await writeFile(path("new.dseal"), "someone else's");
    await expect(output.commit()).rejects.toBeInstanceOf(OutputExistsError);
    await output.abort();
    expect(text(await readFile(path("new.dseal")))).toBe("someone else's");
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("refuses an existing file at once unless asked to replace it", async () => {
    await expect(createOutput(path("secret.txt"), { overwrite: false })).rejects.toThrow("secret.txt already exists");
    const output = await createOutput(path("secret.txt"), { overwrite: true });
    await output.write(new TextEncoder().encode("replaced"));
    await output.commit();
    expect(text(await readFile(path("secret.txt")))).toBe("replaced");
  });
});
