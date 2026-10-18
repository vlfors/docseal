import { deflateSync, inflateSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { utf8 } from "./bytes.js";
import { MEDIA_TYPE } from "./constants.js";
import { DEFAULT_LIMITS, openContainer, readContainer, writeContainer, type PackageContents } from "./container.js";
import { FormatError } from "./errors.js";
import { memorySink, type ByteSink, type ByteSource } from "./io.js";
import { MARKER_16, MARKER_32, crc32, platformRejectsTrailingData } from "./zip.js";
import { ZipWriter } from "./zip-writer.js";

const contents = (): PackageContents => ({
  manifest: utf8("{}"),
  statement: utf8("{}"),
  files: new Map([
    ["a.txt", utf8("hello")],
    ["b.bin", new Uint8Array(5000).fill(7)],
  ]),
  signatures: new Map([["signatures/0001.json", utf8("{}")]]),
  anchors: new Map(),
});

async function expectRejected(zip: Uint8Array, message?: RegExp): Promise<void> {
  const error: unknown = await readContainer(zip).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FormatError);
  if (message) {
    expect((error as FormatError).message).toMatch(message);
  }
}

function view(zip: Uint8Array): DataView {
  return new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
}

/** Offset of the first header with this signature whose name is `name`. */
function headerOf(zip: Uint8Array, signature: number, name: string): number {
  const v = view(zip);
  const nameOffset = signature === 0x04034b50 ? 30 : 46;
  const target = utf8(name);
  for (let pos = 0; pos < zip.length - 4; pos++) {
    if (v.getUint32(pos, true) === signature && target.every((byte, i) => zip[pos + nameOffset + i] === byte)) {
      return pos;
    }
  }
  throw new Error(`no header for ${name}`);
}

function lastIndexOf(zip: Uint8Array, signature: number): number {
  for (let pos = zip.length - 4; pos >= 0; pos--) {
    if (view(zip).getUint32(pos, true) === signature) {
      return pos;
    }
  }
  throw new Error("signature not found");
}

describe("ZIP64", () => {
  it("round-trips a container written with ZIP64 fields everywhere", async () => {
    const zip = await writeContainer(contents(), { forceZip64: true });
    const read = await readContainer(zip);
    expect(read.files).toEqual(contents().files);
    expect(read.signatures).toEqual(contents().signatures);

    const end = lastIndexOf(zip, 0x06054b50);
    expect(view(zip).getUint16(end + 10, true)).toBe(MARKER_16);
    expect(view(zip).getUint32(end + 16, true)).toBe(MARKER_32);
    const central = headerOf(zip, 0x02014b50, "files/b.bin");
    expect(view(zip).getUint32(central + 42, true)).toBe(MARKER_32);
  });

  it("writes no ZIP64 records when nothing needs them", async () => {
    const zip = await writeContainer(contents());
    expect(() => lastIndexOf(zip, 0x06064b50)).toThrow();
    expect(zip.some((_, i) => i + 4 <= zip.length && view(zip).getUint32(i, true) === 0x07064b50)).toBe(false);
  });

  it("rejects an end record whose counts disagree with the ZIP64 record", async () => {
    const zip = await writeContainer(contents(), { forceZip64: true });
    const end = lastIndexOf(zip, 0x06054b50);
    view(zip).setUint16(end + 10, 3, true);
    await expectRejected(zip, /disagrees with the ZIP64 record/);
  });

  it("rejects ZIP64 markers without a ZIP64 record", async () => {
    const zip = await writeContainer(contents());
    const end = lastIndexOf(zip, 0x06054b50);
    view(zip).setUint32(end + 16, MARKER_32, true);
    await expectRejected(zip, /missing ZIP64 record/);
  });

  it("rejects a ZIP64 record that is not right before its locator", async () => {
    const zip = await writeContainer(contents(), { forceZip64: true });
    const locator = lastIndexOf(zip, 0x07064b50);
    const record = Number(view(zip).getBigUint64(locator + 8, true));
    view(zip).setBigUint64(locator + 8, BigInt(record - 1), true);
    await expectRejected(zip, /ZIP64 end of central directory/);
  });

  it("rejects a ZIP64 extra block with fields the header does not ask for", async () => {
    const zip = await writeContainer(contents(), { forceZip64: true });
    const central = headerOf(zip, 0x02014b50, "files/a.txt");
    // The header now carries its real offset, so the block has one 8-byte field too many.
    view(zip).setUint32(central + 42, Number(view(zip).getBigUint64(central + 46 + "files/a.txt".length + 4 + 16, true)), true);
    await expectRejected(zip, /Unexpected ZIP64 fields/);
  });

  it("rejects local ZIP64 sizes that disagree with the central directory", async () => {
    const zip = await writeContainer(contents(), { forceZip64: true });
    const local = headerOf(zip, 0x04034b50, "files/a.txt");
    const extra = local + 30 + "files/a.txt".length;
    view(zip).setBigUint64(extra + 4, 4n, true); // uncompressed size 5 → 4
    await expectRejected(zip, /disagrees with the central directory/);
  });

  it("rejects a local header with one size marker and no ZIP64 block", async () => {
    const zip = await writeContainer(contents());
    const local = headerOf(zip, 0x04034b50, "files/a.txt");
    view(zip).setUint32(local + 22, MARKER_32, true);
    await expectRejected(zip, /ZIP64 sizes/);
  });

  it("handles entries and offsets beyond 4 GiB", async () => {
    const big = 2 ** 32 + 5;
    const file = new SparseFile();
    const zip = new ZipWriter(file);
    await zip.add("mimetype", utf8(MEDIA_TYPE), { compress: false });
    await zip.add("manifest.json", utf8("{}"), { compress: true });
    await zip.add("statement.json", utf8("{}"), { compress: true });
    // The CRC is never checked here: only the structure is read back.
    await zip.addRaw("files/big.bin", { method: 0, crc: 0, size: big, compressedSize: big }, zeros(big));
    await zip.add("signatures/0001.json", utf8('{"after":"4 GiB"}'), { compress: false });
    await zip.finish();

    const container = await openContainer(file);
    expect(container.files.get("big.bin")?.size).toBe(big);
    // Read through a local header that sits past 4 GiB.
    expect(new TextDecoder().decode(container.signatures.get("signatures/0001.json"))).toBe('{"after":"4 GiB"}');
  });
});

describe("ZIP64 at the boundary", () => {
  it("uses ZIP64 for a size of exactly 0xFFFFFFFF, which is the marker value", async () => {
    const file = new SparseFile();
    const zip = new ZipWriter(file);
    await zip.add("mimetype", utf8(MEDIA_TYPE), { compress: false });
    await zip.add("manifest.json", utf8("{}"), { compress: true });
    await zip.add("statement.json", utf8("{}"), { compress: true });
    await zip.addRaw("files/edge.bin", { method: 0, crc: 0, size: MARKER_32, compressedSize: MARKER_32 }, zeros(MARKER_32));
    await zip.add("signatures/0001.json", utf8("{}"), { compress: false });
    await zip.finish();
    const container = await openContainer(file);
    expect(container.files.get("edge.bin")?.size).toBe(MARKER_32);
    expect(new TextDecoder().decode(container.signatures.get("signatures/0001.json"))).toBe("{}");
  });
});

describe("headers written", () => {
  it("carry the version needed, UTF-8 flag, and a fixed 1980-01-01 timestamp", async () => {
    for (const [forceZip64, version] of [
      [false, 20],
      [true, 45],
    ] as const) {
      const zip = await writeContainer(contents(), { forceZip64 });
      const v = view(zip);
      // The first local header is at 0; find the first central header.
      expect([v.getUint16(4, true), v.getUint16(6, true), v.getUint16(10, true), v.getUint16(12, true)]).toEqual([version, 0x0800, 0, 0x21]);
      let pos = 0;
      for (let i = 0; i + 4 <= zip.length; i++) {
        if (v.getUint32(i, true) === 0x02014b50) {
          pos = i;
          break;
        }
      }
      expect([v.getUint16(pos + 4, true), v.getUint16(pos + 6, true), v.getUint16(pos + 8, true), v.getUint16(pos + 12, true), v.getUint16(pos + 14, true)]).toEqual([version, version, 0x0800, 0, 0x21]);
    }
  });
});

describe("extra fields", () => {
  /** Rewrites the container with `extra` added to the central and local headers of files/a.txt. */
  async function withExtra(extra: Uint8Array): Promise<Uint8Array> {
    const zip = await writeContainer(contents());
    const name = "files/a.txt";
    const local = headerOf(zip, 0x04034b50, name);
    const central = headerOf(zip, 0x02014b50, name);
    const parts = [
      zip.subarray(0, local + 30 + name.length),
      extra,
      zip.subarray(local + 30 + name.length, central + 46 + name.length),
      extra,
      zip.subarray(central + 46 + name.length),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    const v = view(out);
    const newCentral = central + extra.length;
    v.setUint16(local + 28, extra.length, true);
    v.setUint16(newCentral + 30, extra.length, true);
    // Everything after the local header moved; fix the offsets that point past it.
    for (let pos = newCentral; pos < out.length - 4; pos++) {
      if (v.getUint32(pos, true) === 0x02014b50 && v.getUint32(pos + 42, true) > local) {
        v.setUint32(pos + 42, v.getUint32(pos + 42, true) + extra.length, true);
      }
    }
    const end = lastIndexOf(out, 0x06054b50);
    v.setUint32(end + 12, v.getUint32(end + 12, true) + extra.length, true);
    v.setUint32(end + 16, v.getUint32(end + 16, true) + extra.length, true);
    return out;
  }

  function block(id: number, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + data.length);
    view(out).setUint16(0, id, true);
    view(out).setUint16(2, data.length, true);
    out.set(data, 4);
    return out;
  }

  it("accepts unrelated extra blocks, such as timestamps", async () => {
    const zip = await withExtra(block(0x5455, new Uint8Array(5)));
    expect((await readContainer(zip)).files.get("a.txt")).toEqual(utf8("hello"));
  });

  it("rejects a Unicode Path block, which some tools extract under instead", async () => {
    const name = utf8("files/evil.txt");
    const data = new Uint8Array(5 + name.length);
    data[0] = 1;
    view(data).setUint32(1, crc32(utf8("files/a.txt")), true);
    data.set(name, 5);
    await expectRejected(await withExtra(block(0x7075, data)), /Unicode Path/);
  });

  it("rejects truncated and repeated blocks", async () => {
    await expectRejected(await withExtra(new Uint8Array([0x55, 0x54, 9, 0])), /extra field/);
    await expectRejected(await withExtra(new Uint8Array([...block(0x5455, new Uint8Array(1)), ...block(0x5455, new Uint8Array(1))])), /extra field/);
  });
});

/**
 * An in-memory "file" that does not store runs of zeros, so archives larger than memory can be
 * written and read back.
 */
class SparseFile implements ByteSink, ByteSource {
  private readonly segments: { offset: number; data: Uint8Array | number }[] = [];
  size = 0;

  write(chunk: Uint8Array): Promise<void> {
    const isZero = chunk === ZERO_CHUNK;
    this.segments.push({ offset: this.size, data: isZero ? chunk.length : chunk.slice() });
    this.size += chunk.length;
    return Promise.resolve();
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (const segment of this.segments) {
      const segmentLength = typeof segment.data === "number" ? segment.data : segment.data.length;
      const start = Math.max(offset, segment.offset);
      const end = Math.min(offset + length, segment.offset + segmentLength);
      if (start < end && typeof segment.data !== "number") {
        out.set(segment.data.subarray(start - segment.offset, end - segment.offset), start - offset);
      }
    }
    return Promise.resolve(out);
  }
}

const ZERO_CHUNK = new Uint8Array(64 * 1024 * 1024);

function* zeros(length: number): Generator<Uint8Array> {
  for (let left = length; left > 0; left -= ZERO_CHUNK.length) {
    yield left >= ZERO_CHUNK.length ? ZERO_CHUNK : new Uint8Array(left);
  }
}

describe("crc32", () => {
  it("matches the byte-wise definition at every length and alignment, and continues", () => {
    const bytewise = (data: Uint8Array, previous = 0) => {
      let crc = ~previous;
      for (const byte of data) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      }
      return ~crc >>> 0;
    };
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 131 + 7) & 0xff);
    for (let start = 0; start < 9; start++) {
      for (let end = start; end <= data.length; end += 7) {
        expect(crc32(data.subarray(start, end))).toBe(bytewise(data.subarray(start, end)));
      }
    }
    expect(crc32(data.subarray(100), crc32(data.subarray(0, 100)))).toBe(bytewise(data));
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });
});

describe("deflate data", () => {
  /** A container whose files/a.txt holds `raw` as its deflate data, declared as `size` bytes of `content`. */
  async function withDeflate(raw: Uint8Array, content: Uint8Array): Promise<Uint8Array> {
    const sink = memorySink();
    const zip = new ZipWriter(sink);
    await zip.add("mimetype", utf8(MEDIA_TYPE), { compress: false });
    await zip.add("manifest.json", utf8("{}"), { compress: false });
    await zip.add("statement.json", utf8("{}"), { compress: false });
    await zip.addRaw("files/a.txt", { method: 8, crc: crc32(content), size: content.length, compressedSize: raw.length }, [raw]);
    await zip.finish();
    return sink.bytes();
  }
  const content = utf8("hello hello hello hello");
  const stream = deflateSync(content);

  it("accepts one complete stream", async () => {
    expect((await readContainer(await withDeflate(stream, content))).files.get("a.txt")).toEqual(content);
  });

  it("rejects bytes after the end of the stream", async () => {
    await expectRejected(await withDeflate(new Uint8Array([...stream, 0, 1, 2]), content), /one complete deflate stream/);
  });

  it("probes the platform once per DecompressionStream implementation", async () => {
    const first = platformRejectsTrailingData();
    expect(platformRejectsTrailingData()).toBe(first);
    expect(typeof (await first)).toBe("boolean");
  });

  // Node.js 22 ignores bytes after the end of the stream, as fflate does; the Compression Streams
  // standard and Node.js 24 reject them. The rule must hold on both.
  describe("on a platform that ignores bytes after the end", () => {
    class IgnoresTrailingData extends TransformStream<Uint8Array, Uint8Array> {
      constructor() {
        const chunks: number[] = [];
        super({
          transform: (chunk) => {
            chunks.push(...chunk);
          },
          flush: (controller) => {
            controller.enqueue(inflateSync(new Uint8Array(chunks)));
          },
        });
      }
    }
    beforeEach(() => {
      vi.stubGlobal("DecompressionStream", IgnoresTrailingData);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("is detected", async () => {
      expect(await platformRejectsTrailingData()).toBe(false);
    });

    it("accepts a stream that ends in its last byte", async () => {
      expect((await readContainer(await withDeflate(stream, content))).files.get("a.txt")).toEqual(content);
      // A stored block ends with its data, not with a Huffman code.
      const stored = new Uint8Array([0x01, 0x05, 0x00, 0xfa, 0xff, ...utf8("hello")]);
      expect((await readContainer(await withDeflate(stored, utf8("hello")))).files.get("a.txt")).toEqual(utf8("hello"));
      expect((await readContainer(await withDeflate(new Uint8Array([0x03, 0x00]), new Uint8Array()))).files.get("a.txt")).toEqual(new Uint8Array());
    });

    it.each([1, 2, 100])("rejects %i byte(s) after the end", async (extra) => {
      const raw = new Uint8Array([...stream, ...new Uint8Array(extra).fill(0xaa)]);
      await expectRejected(await withDeflate(raw, content), /one complete deflate stream/);
    });

    it("still rejects an unfinished stream", async () => {
      await expectRejected(await withDeflate(stream.subarray(0, stream.length - 1), content), /one complete deflate stream/);
    });
  });

  it("rejects a stream that never reaches its final block", async () => {
    await expectRejected(await withDeflate(new Uint8Array([0x02, 0x00]), new Uint8Array()), /one complete deflate stream/);
    await expectRejected(await withDeflate(stream.subarray(0, stream.length - 1), content));
  });
});

describe("end of central directory", () => {
  /** The archive with `comment` as its archive comment. */
  function withComment(zip: Uint8Array, comment: Uint8Array): Uint8Array {
    const out = new Uint8Array(zip.length + comment.length);
    out.set(zip);
    out.set(comment, zip.length);
    new DataView(out.buffer).setUint16(zip.length - 22 + 20, comment.length, true);
    return out;
  }

  it("finds the end record behind an archive comment of the maximum length", async () => {
    for (const forceZip64 of [false, true]) {
      const zip = withComment(await writeContainer(contents(), { forceZip64 }), new Uint8Array(0xffff).fill(0x41));
      expect([...(await readContainer(zip)).files.keys()]).toEqual(["a.txt", "b.bin"]);
    }
  });

  it("is not fooled by an end record signature inside the comment", async () => {
    // A fake record whose comment length does not reach the end of the archive.
    const fake = new Uint8Array(30);
    new DataView(fake.buffer).setUint32(4, 0x06054b50, true);
    const zip = withComment(await writeContainer(contents()), fake);
    expect([...(await readContainer(zip)).files.keys()]).toEqual(["a.txt", "b.bin"]);
  });

  it("rejects a central directory larger than 64 MiB before reading it", async () => {
    // A source that is all zeros but for an end record naming a huge central directory.
    const huge = (directorySize: number): ByteSource => {
      const size = directorySize + 22;
      const end = new Uint8Array(22);
      const view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, 1, true);
      view.setUint16(10, 1, true);
      view.setUint32(12, directorySize, true);
      return {
        size,
        read: (offset, length) => {
          const out = new Uint8Array(length);
          for (let i = Math.max(offset, size - 22); i < offset + length; i++) out[i - offset] = end[i - (size - 22)] ?? 0;
          return Promise.resolve(out);
        },
      };
    };
    const error = (directorySize: number) => openContainer(huge(directorySize)).then(() => undefined, (e: unknown) => e as FormatError);
    expect(await error(64 * 1024 * 1024 + 1)).toEqual(new FormatError("limit", "Central directory is too large"));
    expect((await error(64 * 1024 * 1024))?.message).not.toBe("Central directory is too large");
  });

  it("names the entry limit it enforces", async () => {
    await expect(readContainer(await writeContainer(contents()), { ...DEFAULT_LIMITS, maxEntries: 3 })).rejects.toThrow(new FormatError("limit", "More than 3 entries"));
  });
});
