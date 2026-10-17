/**
 * Streaming ZIP writing, with ZIP64 records only where a size, offset, or count needs them.
 *
 * Sizes and CRC-32 always go in the local header (the format forbids data descriptors), so
 * every entry's size and CRC must be known before its data is written. Callers that stream
 * a document therefore read it twice: once to hash it, once to write it.
 */
import { deflateSync } from "fflate";
import { utf8 } from "./bytes.js";
import type { ByteSink } from "./io.js";
import {
  CENTRAL_HEADER,
  END_OF_CENTRAL_DIRECTORY,
  FLAG_UTF8,
  LOCAL_HEADER,
  MARKER_16,
  MARKER_32,
  METHOD_DEFLATE,
  METHOD_STORED,
  ZIP64_END_OF_CENTRAL_DIRECTORY,
  ZIP64_EXTRA,
  ZIP64_LOCATOR,
  crc32,
} from "./zip.js";

export interface ZipWriterOptions {
  /** Write ZIP64 fields even where the values fit in 32 bits. For tests and test vectors. */
  forceZip64?: boolean;
}

/** What the headers say about an entry's data. */
export interface EntryHeader {
  method: number;
  crc: number;
  size: number;
  compressedSize: number;
}

interface WrittenEntry extends EntryHeader {
  nameBytes: Uint8Array;
  localOffset: number;
}

const VERSION = 20;
const VERSION_ZIP64 = 45;
// Entries are timestamped with the DOS epoch (1980-01-01 00:00) so the same contents give
// the same container bytes.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

export class ZipWriter {
  private offset = 0;
  private readonly entries: WrittenEntry[] = [];
  private readonly names = new Set<string>();
  private finished = false;

  constructor(
    private readonly sink: ByteSink,
    private readonly options: ZipWriterOptions = {},
  ) {}

  /**
   * Adds an entry held in memory, deflated when `compress` is set and that makes it smaller.
   * `crc`, if given, is the CRC-32 computed earlier; a mismatch means the data changed since.
   */
  async add(name: string, data: Uint8Array, options: { compress: boolean; crc?: number }): Promise<void> {
    const crc = crc32(data);
    if (options.crc !== undefined && options.crc !== crc) {
      throw changed(name);
    }
    const deflated = options.compress && data.length > 0 ? deflateSync(data) : undefined;
    if (deflated && deflated.length < data.length) {
      await this.addRaw(name, { method: METHOD_DEFLATE, crc, size: data.length, compressedSize: deflated.length }, once(deflated));
    } else {
      await this.addRaw(name, { method: METHOD_STORED, crc, size: data.length, compressedSize: data.length }, once(data));
    }
  }

  /**
   * Adds an uncompressed entry streamed from `chunks`, whose size and CRC-32 were computed
   * beforehand. Throws if the data turns out different, e.g. a file changed in between.
   */
  async addStored(name: string, size: number, crc: number, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    let actual = 0;
    async function* checked(): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunks) {
        actual = crc32(chunk, actual);
        yield chunk;
      }
      if (actual !== crc) {
        throw changed(name);
      }
    }
    await this.addRaw(name, { method: METHOD_STORED, crc, size, compressedSize: size }, checked());
  }

  /** Writes an entry's data exactly as given, already compressed per `header`. */
  async addRaw(name: string, header: EntryHeader, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void> {
    if (this.finished) {
      throw new Error("ZIP already finished");
    }
    if (this.names.has(name)) {
      throw new Error(`Duplicate entry ${JSON.stringify(name)}`);
    }
    this.names.add(name);
    const nameBytes = utf8(name);
    const localOffset = this.offset;
    await this.write(this.localHeader(nameBytes, header));
    let written = 0;
    for await (const chunk of chunks) {
      written += chunk.length;
      if (written > header.compressedSize) {
        break;
      }
      await this.write(chunk);
    }
    if (written !== header.compressedSize) {
      throw changed(name);
    }
    this.entries.push({ ...header, nameBytes, localOffset });
  }

  /** Writes the central directory and the end records. */
  async finish(): Promise<void> {
    if (this.finished) {
      throw new Error("ZIP already finished");
    }
    this.finished = true;
    const directoryOffset = this.offset;
    for (const entry of this.entries) {
      await this.write(this.centralHeader(entry));
    }
    const directorySize = this.offset - directoryOffset;
    const count = this.entries.length;

    const force = this.options.forceZip64 === true;
    const countOverflows = force || count >= MARKER_16;
    const sizeOverflows = force || directorySize >= MARKER_32;
    const offsetOverflows = force || directoryOffset >= MARKER_32;
    if (countOverflows || sizeOverflows || offsetOverflows) {
      const recordOffset = this.offset;
      const record = new DataView(new ArrayBuffer(56));
      record.setUint32(0, ZIP64_END_OF_CENTRAL_DIRECTORY, true);
      record.setBigUint64(4, 44n, true);
      record.setUint16(12, VERSION_ZIP64, true);
      record.setUint16(14, VERSION_ZIP64, true);
      record.setBigUint64(24, BigInt(count), true);
      record.setBigUint64(32, BigInt(count), true);
      record.setBigUint64(40, BigInt(directorySize), true);
      record.setBigUint64(48, BigInt(directoryOffset), true);
      const locator = new DataView(new ArrayBuffer(20));
      locator.setUint32(0, ZIP64_LOCATOR, true);
      locator.setBigUint64(8, BigInt(recordOffset), true);
      locator.setUint32(16, 1, true);
      await this.write(bytesOf(record));
      await this.write(bytesOf(locator));
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
    end.setUint16(8, countOverflows ? MARKER_16 : count, true);
    end.setUint16(10, countOverflows ? MARKER_16 : count, true);
    end.setUint32(12, sizeOverflows ? MARKER_32 : directorySize, true);
    end.setUint32(16, offsetOverflows ? MARKER_32 : directoryOffset, true);
    await this.write(bytesOf(end));
  }

  private localHeader(nameBytes: Uint8Array, header: EntryHeader): Uint8Array {
    const zip64 = this.options.forceZip64 === true || header.size >= MARKER_32 || header.compressedSize >= MARKER_32;
    const extraLength = zip64 ? 20 : 0;
    const out = new Uint8Array(30 + nameBytes.length + extraLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, LOCAL_HEADER, true);
    view.setUint16(4, zip64 ? VERSION_ZIP64 : VERSION, true);
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, header.method, true);
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, header.crc, true);
    view.setUint32(18, zip64 ? MARKER_32 : header.compressedSize, true);
    view.setUint32(22, zip64 ? MARKER_32 : header.size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, extraLength, true);
    out.set(nameBytes, 30);
    if (zip64) {
      const extra = 30 + nameBytes.length;
      view.setUint16(extra, ZIP64_EXTRA, true);
      view.setUint16(extra + 2, 16, true);
      view.setBigUint64(extra + 4, BigInt(header.size), true);
      view.setBigUint64(extra + 12, BigInt(header.compressedSize), true);
    }
    return out;
  }

  private centralHeader(entry: WrittenEntry): Uint8Array {
    const force = this.options.forceZip64 === true;
    // Only the fields that overflow go into the ZIP64 block, in this order.
    const fields = [
      { value: entry.size, overflows: force || entry.size >= MARKER_32 },
      { value: entry.compressedSize, overflows: force || entry.compressedSize >= MARKER_32 },
      { value: entry.localOffset, overflows: force || entry.localOffset >= MARKER_32 },
    ];
    const overflowing = fields.filter((field) => field.overflows);
    const extraLength = overflowing.length > 0 ? 4 + 8 * overflowing.length : 0;
    const out = new Uint8Array(46 + entry.nameBytes.length + extraLength);
    const view = new DataView(out.buffer);
    const version = overflowing.length > 0 ? VERSION_ZIP64 : VERSION;
    view.setUint32(0, CENTRAL_HEADER, true);
    view.setUint16(4, version, true);
    view.setUint16(6, version, true);
    view.setUint16(8, FLAG_UTF8, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, DOS_TIME, true);
    view.setUint16(14, DOS_DATE, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, fields[1]?.overflows ? MARKER_32 : entry.compressedSize, true);
    view.setUint32(24, fields[0]?.overflows ? MARKER_32 : entry.size, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, extraLength, true);
    view.setUint32(42, fields[2]?.overflows ? MARKER_32 : entry.localOffset, true);
    out.set(entry.nameBytes, 46);
    if (extraLength > 0) {
      let pos = 46 + entry.nameBytes.length;
      view.setUint16(pos, ZIP64_EXTRA, true);
      view.setUint16(pos + 2, extraLength - 4, true);
      pos += 4;
      for (const field of overflowing) {
        view.setBigUint64(pos, BigInt(field.value), true);
        pos += 8;
      }
    }
    return out;
  }

  private async write(chunk: Uint8Array): Promise<void> {
    await this.sink.write(chunk);
    this.offset += chunk.length;
  }
}

function changed(name: string): Error {
  return new Error(`Contents of ${name} changed while the package was being written`);
}

function* once(data: Uint8Array): Generator<Uint8Array> {
  if (data.length > 0) {
    yield data;
  }
}

function bytesOf(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer);
}
