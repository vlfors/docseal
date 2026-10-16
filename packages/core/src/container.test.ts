import { zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { MEDIA_TYPE } from "./constants.js";
import { DEFAULT_LIMITS, readContainer, writeContainer, type PackageContents } from "./container.js";
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

/** Stored, UTF-8 flagged local header followed by the data. CRCs are zero: the reader ignores them. */
function localHeader(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = utf8(name);
  const out = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
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
  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const central = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(central.buffer);
    const host = entry.insideDataOf ?? entry.name;
    const localOffset = (offsets.get(host) ?? 0) + (entry.insideDataOf === undefined ? 0 : 30 + utf8(host).length);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
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
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, offset - directoryOffset, true);
  view.setUint32(16, directoryOffset, true);
  parts.push(end);
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

function expectRejected(zip: Uint8Array, code?: string): void {
  try {
    readContainer(zip);
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
  it("round-trips, including Unicode paths", () => {
    const original = contents();
    const read = readContainer(writeContainer(original));
    expect(read.files).toEqual(original.files);
    expect(read.signatures).toEqual(original.signatures);
    expect(read.manifest).toEqual(original.manifest);
  });

  it("writes byte-identical containers for identical contents", () => {
    expect(writeContainer(contents())).toEqual(writeContainer(contents()));
  });

  it("stores mimetype first and uncompressed", () => {
    const zip = writeContainer(contents());
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
  ])("rejects entry %j", (name, code) => {
    expectRejected(zipWith({ [name]: utf8("x") }), code);
  });

  it("rejects case collisions between files", () => {
    expectRejected(zipWith({ "files/A.txt": utf8("1"), "files/a.txt": utf8("2") }), "path-collision");
  });

  it("rejects duplicate entry names", () => {
    const zip = zipWith({ "files/a.txt": utf8("1"), "files/b.txt": utf8("2") });
    expectRejected(patch(zip, "files/b.txt", "files/a.txt"), "duplicate-entry");
  });

  it("rejects symlinks", () => {
    const zip = zipWith({ "files/link": [utf8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] });
    expectRejected(zip, "entry-type");
  });

  it("rejects a missing, compressed, or wrong mimetype", () => {
    expectRejected(zipSync({ "manifest.json": utf8("{}"), "statement.json": utf8("{}") }), "mimetype");
    expectRejected(zipWith({}, { mimetype: [utf8(MEDIA_TYPE), { level: 9 }] }), "mimetype");
    expectRejected(zipWith({}, { mimetype: [utf8("application/zip"), { level: 0 }] }), "mimetype");
  });

  it("rejects missing manifest or statement", () => {
    expectRejected(zipSync({ mimetype: [utf8(MEDIA_TYPE), { level: 0 }], "manifest.json": utf8("{}") }), "missing-entry");
  });

  it("rejects data prepended or appended to the archive", () => {
    const zip = writeContainer(contents());
    expectRejected(new Uint8Array([0, ...zip]));
    expectRejected(new Uint8Array([...zip, 0]));
  });

  it("rejects a high compression ratio (ZIP bomb)", () => {
    const zip = zipWith({ "files/zeros.bin": new Uint8Array(10 * 1024 * 1024) });
    expectRejected(zip, "limit");
  });

  it("enforces size and entry limits", () => {
    const zip = writeContainer(contents());
    expect(() => readContainer(zip, { ...DEFAULT_LIMITS, maxDocumentSize: 999 })).toThrow(FormatError);
    expect(() => readContainer(zip, { ...DEFAULT_LIMITS, maxTotalDocumentSize: 1004 })).toThrow(FormatError);
    expect(() => readContainer(zip, { ...DEFAULT_LIMITS, maxEntries: 5 })).toThrow(FormatError);
  });

  it("rejects an entry hidden inside the data of another (overlapping entries)", () => {
    const hidden = localHeader("files/b.txt", utf8("x"));
    const zip = rawZip([
      { name: "mimetype", data: utf8(MEDIA_TYPE) },
      { name: "manifest.json", data: utf8("{}") },
      { name: "statement.json", data: utf8("{}") },
      { name: "files/a.bin", data: hidden },
      { name: "files/b.txt", data: utf8("x"), insideDataOf: "files/a.bin" },
    ]);
    expectRejected(zip, "zip");
  });

  it("accepts the same layout without overlap", () => {
    const zip = rawZip([
      { name: "mimetype", data: utf8(MEDIA_TYPE) },
      { name: "manifest.json", data: utf8("{}") },
      { name: "statement.json", data: utf8("{}") },
      { name: "files/b.txt", data: utf8("x") },
    ]);
    expect(readContainer(zip).files.get("b.txt")).toEqual(utf8("x"));
  });

  it("rejects an entry whose declared size is smaller than its contents", () => {
    const zip = writeContainer(contents());
    // Shrink the declared uncompressed size of the 1000-byte document in the central directory.
    const view = new DataView(zip.buffer);
    for (let pos = 0; pos < zip.length - 4; pos++) {
      if (view.getUint32(pos, true) === 0x02014b50 && view.getUint32(pos + 24, true) === 1000) {
        view.setUint32(pos + 24, 999, true);
      }
    }
    expectRejected(zip);
  });

  it("never throws anything but FormatError on corrupted input", () => {
    const zip = writeContainer(contents());
    for (let i = 0; i < zip.length; i += 7) {
      const corrupted = zip.slice();
      corrupted[i] = (corrupted[i] ?? 0) ^ 0xff;
      try {
        readContainer(corrupted);
      } catch (error) {
        expect(error).toBeInstanceOf(FormatError);
      }
    }
  });
});
