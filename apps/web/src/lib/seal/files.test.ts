import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles } from "../../../../cli/src/files";
import { fromDroppedEntries, fromFileInput, fromFolderInput, planFiles, type Entry } from "./files";

const file = (name: string, content = "x", relative = "") => {
  const f = new File([content], name);
  Object.defineProperty(f, "webkitRelativePath", { value: relative });
  return f;
};

/** Fake drop entries; directories hand out their entries in batches of two, as readEntries may. */
function fileEntry(name: string): Entry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (ok: (f: File) => void) => {
      ok(file(name));
    },
  } as Entry;
}
function directoryEntry(name: string, children: Entry[]): Entry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let offset = 0;
      return {
        readEntries(ok: (entries: Entry[]) => void) {
          ok(children.slice(offset, offset + 2));
          offset += 2;
        },
      };
    },
  } as Entry;
}

describe("collecting files", () => {
  it("stores a chosen file under its name and a chosen folder's files below it", () => {
    expect(fromFileInput([file("a.txt"), file("b.pdf")]).map((f) => f.path)).toEqual(["a.txt", "b.pdf"]);
    expect(fromFolderInput([file("a.txt", "x", "docs/a.txt"), file("b.txt", "x", "docs/sub/b.txt")]).map((f) => f.path)).toEqual(["a.txt", "sub/b.txt"]);
  });

  it("walks a dropped folder through every batch of entries", async () => {
    const dropped = [
      directoryEntry("docs", [fileEntry("a.txt"), directoryEntry("sub", [fileEntry("b.txt"), fileEntry("c.txt"), fileEntry("d.txt")]), fileEntry("e.txt")]),
      fileEntry("loose.txt"),
    ];
    expect((await fromDroppedEntries(dropped)).map((f) => f.path)).toEqual(["a.txt", "sub/b.txt", "sub/c.txt", "sub/d.txt", "e.txt", "loose.txt"]);
  });
});

describe("planFiles", () => {
  const plan = (...paths: string[]) => planFiles(paths.map((path) => ({ path, file: file(path) })));
  const problems = (planned: ReturnType<typeof plan>) => planned.map((f) => [f.path, f.problem?.kind ?? "ok"]);

  it("sorts in manifest order and normalizes to NFC, as sealing does", () => {
    expect(problems(plan("b.txt", "é.txt", "a/z.txt"))).toEqual([
      ["a/z.txt", "ok"],
      ["b.txt", "ok"],
      ["é.txt", "ok"],
    ]);
  });

  it("marks invalid paths with the core's reason", () => {
    const planned = plan("ok.txt", "bad\u0001.txt");
    expect(problems(planned)).toEqual([
      ["bad\u0001.txt", "invalid"],
      ["ok.txt", "ok"],
    ]);
    expect(planned[0]?.problem).toMatchObject({ message: expect.stringContaining("control character") as unknown });
  });

  it("marks every path the core's collision check rejects, and keeps the first of each group", () => {
    expect(problems(plan("Readme.md", "README.md", "readme.MD", "a", "a/b", "ok.txt"))).toEqual([
      ["README.md", "ok"],
      ["Readme.md", "collision"],
      ["a", "ok"],
      ["a/b", "collision"],
      ["ok.txt", "ok"],
      ["readme.MD", "collision"],
    ]);
  });

  it("finds collisions in a long list quickly", () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `dir/file-${String(i)}.txt`);
    const start = performance.now();
    const planned = plan(...paths, "DIR/FILE-42.TXT");
    expect(planned.filter((f) => f.problem).map((f) => f.path)).toEqual(["dir/file-42.txt"]);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe("compared with the CLI", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "docseal-web-files-"));
    await mkdir(join(dir, "contract", "annex", "deep"), { recursive: true });
    await writeFile(join(dir, "contract", "main.pdf"), "main");
    await writeFile(join(dir, "contract", "annex", "приложение.txt"), "annex");
    await writeFile(join(dir, "contract", "annex", "deep", "x.bin"), "x");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("gives a folder the same package paths as `docseal seal <folder>`", async () => {
    const cli = (await collectFiles([join(dir, "contract")])).map((f) => f.path).sort();
    const chosen = fromFolderInput([
      file("main.pdf", "main", "contract/main.pdf"),
      file("приложение.txt", "annex", "contract/annex/приложение.txt"),
      file("x.bin", "x", "contract/annex/deep/x.bin"),
    ]);
    expect(planFiles(chosen).map((f) => f.path).sort()).toEqual(cli);
  });
});
