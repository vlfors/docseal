import { zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { MEDIA_TYPE } from "./constants.js";
import { DEFAULT_LIMITS, crc32, openContainer, readContainer, rewriteAnchors, writeContainer, type PackageContents } from "./container.js";
import { bytesSource, memorySink } from "./io.js";
import { FormatError } from "./errors.js";

const contents = (): PackageContents => ({
  manifest: utf8("{}"),
  statement: utf8("{}"),
  files: new Map([
    ["a.txt", utf8("hello")],
    ["Папка/документ.pdf", new Uint8Array(1000)],
  ]),
  signatures: new Map([["signatures/0001.json", utf8("{}")]]),
  anchors: new Map(),
});

/** A container with `extra` entries added after the required ones. */
function zipWith(extra: Zippable, options: { mimetype?: Uint8Array | [Uint8Array, object] } = {}): Uint8Array {
  return zipSync({
    mimetype: options.mimetype ?? [utf8(MEDIA_TYPE), { level: 0 }],
    "manifest.json": utf8("{}"),
    "statement.json": utf8("{}"),
    ...extra,
  });
}

/** Stored, UTF-8 flagged local header followed by the data. */
function localHeader(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = utf8(name);
  const out = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint32(14, crc32(data), true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  return out;
}

interface RawEntry {
  name: string;
  data: Uint8Array;
  /** Write no local header; point the central directory into another entry's data instead. */
  insideDataOf?: string;
  /** Write the local header and data, but leave the entry out of the central directory. */
  omitFromDirectory?: boolean;
}

/** Minimal stored-only ZIP writer that can produce layouts fflate refuses to create. */
function rawZip(entries: RawEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const offsets = new Map<string, number>();
  let offset = 0;
  for (const entry of entries.filter((e) => e.insideDataOf === undefined)) {
    const local = localHeader(entry.name, entry.data);
    offsets.set(entry.name, offset);
    parts.push(local);
    offset += local.length;
  }
  const directoryOffset = offset;
  const listed = entries.filter((e) => !e.omitFromDirectory);
  for (const entry of listed) {
    const nameBytes = utf8(entry.name);
    const central = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(central.buffer);
    const host = entry.insideDataOf ?? entry.name;
    const localOffset = (offsets.get(host) ?? 0) + (entry.insideDataOf === undefined ? 0 : 30 + utf8(host).length);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint32(16, crc32(entry.data), true);
    view.setUint32(20, entry.data.length, true);
    view.setUint32(24, entry.data.length, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    parts.push(central);
    offset += central.length;
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, listed.length, true);
  view.setUint16(10, listed.length, true);
  view.setUint32(12, offset - directoryOffset, true);
  view.setUint32(16, directoryOffset, true);
  parts.push(end);
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

async function expectRejected(zip: Uint8Array, code?: string): Promise<void> {
  try {
    await readContainer(zip);
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    if (code !== undefined) {
      expect((error as FormatError).code).toBe(code);
    }
    return;
  }
  throw new Error("Container was accepted");
}

/** Replaces every occurrence of one byte string with another of the same length. */
function patch(zip: Uint8Array, from: string, to: string): Uint8Array {
  const out = zip.slice();
  const needle = utf8(from);
  const replacement = utf8(to);
  for (let i = 0; i <= out.length - needle.length; i++) {
    if (needle.every((byte, j) => out[i + j] === byte)) {
      out.set(replacement, i);
    }
  }
  return out;
}

describe("container", () => {
  it("round-trips, including Unicode paths", async () => {
    const original = contents();
    const read = await readContainer(await writeContainer(original));
    expect(read.files).toEqual(original.files);
    expect(read.signatures).toEqual(original.signatures);
    expect(read.manifest).toEqual(original.manifest);
  });

  it("writes byte-identical containers for identical contents", async () => {
    expect(await writeContainer(contents())).toEqual(await writeContainer(contents()));
  });

  it("stores mimetype first and uncompressed", async () => {
    const zip = await writeContainer(contents());
    expect(new TextDecoder().decode(zip.subarray(30, 38))).toBe("mimetype");
    expect(zip[8]).toBe(0); // compression method of the first local header
  });

  it.each([
    ["files/../evil.txt", "path"],
    ["files//abs", "path"],
    ["files/a\\b", "path"],
    ["files/é.txt", "path"],
    ["evil.sh", "unexpected-entry"],
    ["signatures/1.json", "unexpected-entry"],
    ["anchors/seal-0.json", "unexpected-entry"],
    ["META-INF/manifest.xml", "unexpected-entry"],
  ])("rejects entry %j", async (name, code) => {
    await expectRejected(zipWith({ [name]: utf8("x") }), code);
  });

  it("rejects case collisions between files", async () => {
    await expectRejected(zipWith({ "files/A.txt": utf8("1"), "files/a.txt": utf8("2") }), "path-collision");
  });

  it("rejects duplicate entry names", async () => {
    const zip = zipWith({ "files/a.txt": utf8("1"), "files/b.txt": utf8("2") });
    await expectRejected(patch(zip, "files/b.txt", "files/a.txt"), "duplicate-entry");
  });

  it("rejects symlinks", async () => {
    const zip = zipWith({ "files/link": [utf8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
    await expectRejected(zip, "entry-type");
  });

  it("rejects a missing, compressed, or wrong mimetype", async () => {
    await expectRejected(zipSync({ "manifest.json": utf8("{}"), "statement.json": utf8("{}") }), "mimetype");
    await expectRejected(zipWith({}, { mimetype: [utf8(MEDIA_TYPE), { level: 9 }] }), "mimetype");
    await expectRejected(zipWith({}, { mimetype: [utf8("application/zip"), { level: 0 }] }), "mimetype");
  });

  it("rejects missing manifest or statement", async () => {
    await expectRejected(zipSync({ mimetype: [utf8(MEDIA_TYPE), { level: 0 }], "manifest.json": utf8("{}") }), "missing-entry");
  });

  it("rejects data prepended or appended to the archive", async () => {
    const zip = await writeContainer(contents());
    await expectRejected(new Uint8Array([0, ...zip]));
    await expectRejected(new Uint8Array([...zip, 0]));
  });

  it("accepts empty directory entries for the defined folders and ignores them", async () => {
    const empty = new Uint8Array();
    const read = await readContainer(
      zipWith({ "files/": empty, "files/annex/": empty, "files/annex/a.txt": utf8("a"), "signatures/": empty, "anchors/": empty, "signatures/0001.json": utf8("{}"), "anchors/seal-1.json": utf8("{}") }),
    );
    expect([...read.files.keys()]).toEqual(["annex/a.txt"]);
    expect([...read.signatures.keys()]).toEqual(["signatures/0001.json"]);
    expect([...read.anchors.keys()]).toEqual(["anchors/seal-1.json"]);
  });

  it("rejects directory entries with contents, outside the defined folders, or with invalid paths", async () => {
    await expectRejected(zipWith({ "files/annex/": utf8("x") }), "entry");
    await expectRejected(zipWith({ "signatures/": utf8("x") }), "entry");
    await expectRejected(zipWith({ "META-INF/": new Uint8Array() }), "unexpected-entry");
    await expectRejected(zipWith({ "/files/": new Uint8Array() }), "unexpected-entry");
    await expectRejected(zipWith({ "files/../": new Uint8Array() }), "path");
    await expectRejected(zipWith({ "files/a//": new Uint8Array() }), "path");
  });

  it.each(["signatures/001.json", "signatures/0001.json.bak", "signatures/0001.jsonx", "x/signatures/0001.json", "anchors/seal-0.json", "anchors/seal-01.json", "anchors/seal-1a.json", "anchors/seal-1.json.bak", "x/anchors/seal-1.json", "anchors/seal-.json"])(
    "rejects the entry name %s",
    async (name) => {
      await expectRejected(zipWith({ [name]: utf8("{}") }), "unexpected-entry");
    },
  );

  it("rewrites anchors only of a container it opened itself", async () => {
    const copy = { ...(await openContainer(bytesSource(await writeContainer(contents())))) };
    await expect(rewriteAnchors(copy, new Map(), memorySink())).rejects.toThrow("Container was not opened with openContainer");
  });

  it("rejects a high compression ratio (ZIP bomb)", async () => {
    const zip = zipWith({ "files/zeros.bin": new Uint8Array(10 * 1024 * 1024) });
    await expectRejected(zip, "limit");
  });

  it("enforces size and entry limits", async () => {
    const zip = await writeContainer(contents());
    await expect(readContainer(zip, { ...DEFAULT_LIMITS, maxDocumentSize: 999 })).rejects.toThrow(FormatError);
    await expect(readContainer(zip, { ...DEFAULT_LIMITS, maxTotalDocumentSize: 1004 })).rejects.toThrow(FormatError);
    await expect(readContainer(zip, { ...DEFAULT_LIMITS, maxEntries: 5 })).rejects.toThrow(FormatError);
  });

  it("rejects an entry hidden inside the data of another (overlapping entries)", async () => {
    const hidden = localHeader("files/b.txt", utf8("x"));
    const zip = rawZip([
      { name: "mimetype", data: utf8(MEDIA_TYPE) },
      { name: "manifest.json", data: utf8("{}") },
      { name: "statement.json", data: utf8("{}") },
      { name: "files/a.bin", data: hidden },
      { name: "files/b.txt", data: utf8("x"), insideDataOf: "files/a.bin" },
    ]);
    await expectRejected(zip, "zip");
  });

  it("accepts the same layout without overlap", async () => {
    const zip = rawZip([
      { name: "mimetype", data: utf8(MEDIA_TYPE) },
      { name: "manifest.json", data: utf8("{}") },
      { name: "statement.json", data: utf8("{}") },
      { name: "files/b.txt", data: utf8("x") },
    ]);
    expect((await readContainer(zip)).files.get("b.txt")).toEqual(utf8("x"));
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  /** Offset of the first local or central header whose name is `name`. */
  function headerOf(zip: Uint8Array, signature: number, name: string): number {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const nameOffset = signature === 0x04034b50 ? 30 : 46;
    for (let pos = 0; pos < zip.length - 4; pos++) {
      if (view.getUint32(pos, true) === signature && new TextDecoder().decode(zip.subarray(pos + nameOffset, pos + nameOffset + name.length)) === name) {
        return pos;
      }
    }
    throw new Error(`no header for ${name}`);
  }

  it.each([
    ["method", 8, 2, 8],
    ["CRC", 14, 4, 0x12345678],
    ["compressed size", 18, 4, 1],
  ])("rejects a local header whose %s disagrees with the central directory", async (_, offset, width, value) => {
    const zip = await writeContainer(contents());
    const view = new DataView(zip.buffer);
    const pos = headerOf(zip, 0x04034b50, "files/a.txt");
    if (width === 2) view.setUint16(pos + offset, value, true);
    else view.setUint32(pos + offset, value, true);
    await expectRejected(zip, "zip");
  });

  it("rejects contents that fail the CRC check", async () => {
    const zip = await writeContainer(contents());
    const crcValue = (pos: number) => new DataView(zip.buffer).getUint32(pos, true);
    const local = headerOf(zip, 0x04034b50, "files/a.txt");
    const central = headerOf(zip, 0x02014b50, "files/a.txt");
    // Change the CRC consistently in both headers: only the data check can notice.
    const forged = crcValue(local + 14) ^ 1;
    new DataView(zip.buffer).setUint32(local + 14, forged, true);
    new DataView(zip.buffer).setUint32(central + 16, forged, true);
    await expectRejected(zip, "zip");
  });

  it("rejects data descriptors", async () => {
    const zip = await writeContainer(contents());
    const view = new DataView(zip.buffer);
    const local = headerOf(zip, 0x04034b50, "files/a.txt");
    const central = headerOf(zip, 0x02014b50, "files/a.txt");
    view.setUint16(local + 6, view.getUint16(local + 6, true) | 0x0008, true);
    view.setUint16(central + 8, view.getUint16(central + 8, true) | 0x0008, true);
    await expectRejected(zip, "zip");
  });

  it("rejects a hidden entry in a gap between entries", async () => {
    const entries = [
      { name: "mimetype", data: utf8(MEDIA_TYPE) },
      { name: "manifest.json", data: utf8("{}") },
      { name: "statement.json", data: utf8("{}") },
    ];
    // A local header the central directory never mentions, between two real entries.
    const zip = rawZip([...entries.slice(0, 2), { name: "files/hidden.txt", data: utf8("evil"), omitFromDirectory: true }, ...entries.slice(2)]);
    await expectRejected(zip, "zip");
  });

  it("rejects an entry whose declared size is smaller than its contents", async () => {
    const zip = await writeContainer(contents());
    // Shrink the declared uncompressed size of the 1000-byte document in the central directory.
    const view = new DataView(zip.buffer);
    for (let pos = 0; pos < zip.length - 4; pos++) {
      if (view.getUint32(pos, true) === 0x02014b50 && view.getUint32(pos + 24, true) === 1000) {
        view.setUint32(pos + 24, 999, true);
      }
    }
    await expectRejected(zip);
  });

  it("never throws anything but FormatError on corrupted input", async () => {
    const zip = await writeContainer(contents());
    for (let i = 0; i < zip.length; i += 7) {
      const corrupted = zip.slice();
      corrupted[i] = (corrupted[i] ?? 0) ^ 0xff;
      try {
        await readContainer(corrupted);
      } catch (error) {
        expect(error).toBeInstanceOf(FormatError);
      }
    }
  });
});
