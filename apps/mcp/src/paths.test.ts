import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openInRoots, resolveInRoots } from "./paths.js";

let dir: string;
const path = (...parts: string[]) => join(dir, ...parts);
const OUTSIDE = /is outside the directories this server may read \(--root\)$/;

beforeEach(async () => {
  // Real path: on macOS the temporary directory itself is reached through a link.
  dir = await realpath(await mkdtemp(join(tmpdir(), "docseal-paths-")));
  await mkdir(path("root", "sub"), { recursive: true });
  await mkdir(path("rootless"));
  await mkdir(path("other"));
  await writeFile(path("root", "a.dseal"), "inside");
  await writeFile(path("root", "sub", "b.dseal"), "nested");
  await writeFile(path("rootless", "c.dseal"), "sibling with a common prefix");
  await writeFile(path("other", "d.dseal"), "second root");
  await writeFile(path("secret.txt"), "TOP-SECRET-CONTENT");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(name: string, roots = [path("root")]): Promise<string> {
  const source = await openInRoots(name, roots, "package");
  try {
    return new TextDecoder().decode(await source.read(0, source.size));
  } finally {
    await source.close();
  }
}

describe("file access under --root", () => {
  it("reads files under a root, relative to the first root or absolute", async () => {
    expect(await read("a.dseal")).toBe("inside");
    expect(await read("sub/b.dseal")).toBe("nested");
    expect(await read("./sub/../a.dseal")).toBe("inside");
    expect(await read("sub//b.dseal")).toBe("nested");
    expect(await read(path("root", "a.dseal"))).toBe("inside");
    expect(await read(path("other", "d.dseal"), [path("root"), path("other")])).toBe("second root");
  });

  it.each([
    ["../secret.txt"],
    ["sub/../../secret.txt"],
    ["/etc/passwd"],
    ["../rootless/c.dseal"],
  ])("refuses %s, outside every root", async (name) => {
    await expect(read(name)).rejects.toThrow(OUTSIDE);
  });

  it("refuses a sibling whose name starts like the root", async () => {
    await expect(read(path("rootless", "c.dseal"))).rejects.toThrow(OUTSIDE);
  });

  it("does not even look up a path outside the roots", async () => {
    await expect(read("../does-not-exist")).rejects.toThrow(OUTSIDE);
    await expect(read("does-not-exist")).rejects.toThrow("Cannot read does-not-exist");
  });

  it("refuses links that lead out, and follows links that stay inside", async () => {
    await symlink(path("secret.txt"), path("root", "file-link.dseal"));
    await symlink(dir, path("root", "dir-link"));
    await symlink("../../secret.txt", path("root", "sub", "relative-link.dseal"));
    await symlink(path("root", "a.dseal"), path("root", "sub", "inside-link.dseal"));
    await expect(read("file-link.dseal")).rejects.toThrow(OUTSIDE);
    await expect(read("dir-link/secret.txt")).rejects.toThrow(OUTSIDE);
    await expect(read("dir-link/root/a.dseal")).resolves.toBe("inside");
    await expect(read("sub/relative-link.dseal")).rejects.toThrow(OUTSIDE);
    await expect(read("sub/inside-link.dseal")).resolves.toBe("inside");
  });

  it("accepts a root reached through a link", async () => {
    await symlink(path("root"), path("root-link"));
    expect(await read("a.dseal", [path("root-link")])).toBe("inside");
    await expect(read("../secret.txt", [path("root-link")])).rejects.toThrow(OUTSIDE);
  });

  it("refuses what is not a regular file, without waiting on a FIFO", async () => {
    await expect(read("sub")).rejects.toThrow("sub is not a regular file");
    await expect(read("")).rejects.toThrow("is not a regular file");
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [path("root", "pipe.dseal")]);
      await expect(read("pipe.dseal")).rejects.toThrow("pipe.dseal is not a regular file");
    }
  });

  it("refuses everything without a root", async () => {
    await expect(resolveInRoots("a.dseal", [])).rejects.toThrow("No file access: the server was started without --root");
  });

  it("names the path in errors, never what the file holds", async () => {
    await symlink(path("secret.txt"), path("root", "link.dseal"));
    for (const name of ["../secret.txt", "link.dseal"]) {
      const error = await read(name).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("TOP-SECRET-CONTENT");
      expect((error as Error).message).toBe(`${name} is outside the directories this server may read (--root)`);
    }
  });

  it.runIf(process.platform === "darwin")("refuses a path spelled with other case than its root on macOS", async () => {
    await expect(read(path("ROOT", "a.dseal"))).rejects.toThrow(OUTSIDE);
  });
});
