/**
 * Strict ZIP reading (FORMAT-v0.1 §Container), over a random-access source.
 *
 * The central directory is parsed here rather than by a general-purpose unzip routine,
 * because safe extraction needs what those hide: duplicate names, Unix file types
 * (symlinks), overlapping entries, and declared sizes before anything is inflated.
 * Local headers must agree with the central directory and entries must be contiguous,
 * so that a streaming unzip tool, which reads local headers, sees exactly the bytes
 * DocSeal verified. fflate is only used to inflate the data of individual entries.
 */
import { Inflate } from "fflate";
import { equalBytes } from "./bytes.js";
import { FormatError } from "./errors.js";
import { READ_CHUNK_SIZE, readChunks, type ByteSource } from "./io.js";

export const LOCAL_HEADER = 0x04034b50;
export const CENTRAL_HEADER = 0x02014b50;
export const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
export const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
export const ZIP64_LOCATOR = 0x07064b50;
export const ZIP64_EXTRA = 0x0001;
/** Info-ZIP Unicode Path: some tools extract under this name instead of the header name. */
const UNICODE_PATH_EXTRA = 0x7075;

export const MARKER_16 = 0xffff;
export const MARKER_32 = 0xffffffff;
export const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;
const HOST_UNIX = 3;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_REGULAR = 0o100000;
const UNIX_DIRECTORY = 0o040000;

const END_LENGTH = 22;
const ZIP64_END_LENGTH = 56;
const ZIP64_LOCATOR_LENGTH = 20;
/** Bounds what is read into memory before any entry is looked at. */
export const MAX_CENTRAL_DIRECTORY_SIZE = 64 * 1024 * 1024;
/** Input per inflate step. Deflate expands at most ~1032:1, so one step yields at most ~66 MiB. */
const INFLATE_CHUNK_SIZE = 64 * 1024;

export interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  dataOffset: number;
}

export interface ZipLimits {
  maxEntries: number;
  /** Maximum ratio of uncompressed to compressed size of a single entry. */
  maxCompressionRatio: number;
}

interface DirectoryLocation {
  offset: number;
  size: number;
  entries: number;
}

/** Reads and cross-checks the central directory and every local header. */
export async function readZipDirectory(source: ByteSource, limits: ZipLimits): Promise<ZipEntry[]> {
  const location = await locateCentralDirectory(source);
  if (location.entries > limits.maxEntries) {
    throw invalid("limit", `More than ${String(limits.maxEntries)} entries`);
  }
  if (location.size > MAX_CENTRAL_DIRECTORY_SIZE) {
    throw invalid("limit", "Central directory is too large");
  }
  const directory = await source.read(location.offset, location.size);
  const entries = parseCentralDirectory(directory, location.entries, limits);
  for (const entry of entries) {
    entry.dataOffset = await readLocalHeader(source, entry, location.offset);
  }
  checkContiguous(entries, location.offset);
  return entries;
}

async function locateCentralDirectory(source: ByteSource): Promise<DirectoryLocation> {
  const tailLength = Math.min(source.size, END_LENGTH + 0xffff + ZIP64_LOCATOR_LENGTH + ZIP64_END_LENGTH);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  const view = viewOf(tail);

  let end = -1;
  for (let pos = tail.length - END_LENGTH; pos >= Math.max(0, tail.length - END_LENGTH - 0xffff); pos--) {
    if (view.getUint32(pos, true) === END_OF_CENTRAL_DIRECTORY && pos + END_LENGTH + view.getUint16(pos + 20, true) === tail.length) {
      end = pos;
      break;
    }
  }
  if (end < 0) {
    throw invalid("zip", "Not a ZIP archive");
  }
  const classic = {
    disk: view.getUint16(end + 4, true),
    directoryDisk: view.getUint16(end + 6, true),
    entriesOnDisk: view.getUint16(end + 8, true),
    entries: view.getUint16(end + 10, true),
    size: view.getUint32(end + 12, true),
    offset: view.getUint32(end + 16, true),
  };
  const endOffset = tailStart + end;

  const locator = end - ZIP64_LOCATOR_LENGTH;
  if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) {
    if (
      classic.entries === MARKER_16 ||
      classic.entriesOnDisk === MARKER_16 ||
      classic.size === MARKER_32 ||
      classic.offset === MARKER_32 ||
      classic.disk === MARKER_16 ||
      classic.directoryDisk === MARKER_16
    ) {
      throw invalid("zip", "End of central directory refers to a missing ZIP64 record");
    }
    checkSingleDisk(classic.disk, classic.directoryDisk, classic.entriesOnDisk, classic.entries);
    if (classic.offset + classic.size !== endOffset) {
      throw invalid("zip", "Unexpected data around the central directory");
    }
    return { offset: classic.offset, size: classic.size, entries: classic.entries };
  }

  // ZIP64: the locator points at the ZIP64 end record, which must sit right before it.
  const recordDisk = view.getUint32(locator + 4, true);
  const recordOffset = uint64(view, locator + 8);
  const totalDisks = view.getUint32(locator + 16, true);
  const record = recordOffset - tailStart;
  if (recordDisk !== 0 || totalDisks > 1) {
    throw invalid("zip", "Multi-disk archives are not supported");
  }
  if (record < 0 || record + ZIP64_END_LENGTH !== locator || view.getUint32(record, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY) {
    throw invalid("zip", "Corrupt ZIP64 end of central directory");
  }
  if (uint64(view, record + 4) !== ZIP64_END_LENGTH - 12) {
    throw invalid("zip", "ZIP64 end of central directory has extensible data");
  }
  const zip64 = {
    disk: view.getUint32(record + 16, true),
    directoryDisk: view.getUint32(record + 20, true),
    entriesOnDisk: uint64(view, record + 24),
    entries: uint64(view, record + 32),
    size: uint64(view, record + 40),
    offset: uint64(view, record + 48),
  };
  // Each classic field must be the ZIP64 marker or agree with the ZIP64 record.
  const agrees = (value: number, marker: number, actual: number) => value === marker || value === actual;
  if (
    !agrees(classic.disk, MARKER_16, zip64.disk) ||
    !agrees(classic.directoryDisk, MARKER_16, zip64.directoryDisk) ||
    !agrees(classic.entriesOnDisk, MARKER_16, zip64.entriesOnDisk) ||
    !agrees(classic.entries, MARKER_16, zip64.entries) ||
    !agrees(classic.size, MARKER_32, zip64.size) ||
    !agrees(classic.offset, MARKER_32, zip64.offset)
  ) {
    throw invalid("zip", "End of central directory disagrees with the ZIP64 record");
  }
  checkSingleDisk(zip64.disk, zip64.directoryDisk, zip64.entriesOnDisk, zip64.entries);
  if (zip64.offset + zip64.size !== recordOffset) {
    throw invalid("zip", "Unexpected data around the central directory");
  }
  return { offset: zip64.offset, size: zip64.size, entries: zip64.entries };
}

function checkSingleDisk(disk: number, directoryDisk: number, entriesOnDisk: number, entries: number): void {
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entries) {
    throw invalid("zip", "Multi-disk archives are not supported");
  }
}

function parseCentralDirectory(directory: Uint8Array, count: number, limits: ZipLimits): ZipEntry[] {
  const view = viewOf(directory);
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > directory.length || view.getUint32(pos, true) !== CENTRAL_HEADER) {
      throw invalid("zip", "Corrupt central directory");
    }
    const madeBy = view.getUint16(pos + 4, true);
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compressedSize32 = view.getUint32(pos + 20, true);
    const size32 = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const diskStart16 = view.getUint16(pos + 34, true);
    const externalAttributes = view.getUint32(pos + 38, true);
    const localOffset32 = view.getUint32(pos + 42, true);
    const nameStart = pos + 46;
    const extraStart = nameStart + nameLength;
    pos = extraStart + extraLength + commentLength;
    if (pos > directory.length) {
      throw invalid("zip", "Corrupt central directory");
    }
    const nameBytes = directory.subarray(nameStart, extraStart);
    const name = decodeName(nameBytes, flags);
    if (names.has(name)) {
      throw invalid("duplicate-entry", `Duplicate entry ${JSON.stringify(name)}`);
    }
    names.add(name);
    const where = JSON.stringify(name);

    // The ZIP64 extra field holds exactly the fields whose header value is the marker, in order.
    const extra = parseExtra(directory.subarray(extraStart, extraStart + extraLength), where);
    const fields = new Zip64Fields(extra.get(ZIP64_EXTRA), where);
    const size = size32 === MARKER_32 ? fields.next64() : size32;
    const compressedSize = compressedSize32 === MARKER_32 ? fields.next64() : compressedSize32;
    const localOffset = localOffset32 === MARKER_32 ? fields.next64() : localOffset32;
    const diskStart = diskStart16 === MARKER_16 ? fields.next32() : diskStart16;
    fields.end();
    if (diskStart !== 0) {
      throw invalid("zip", "Multi-disk archives are not supported");
    }

    if (flags & FLAG_ENCRYPTED) {
      throw invalid("zip", `Entry ${where} is encrypted`);
    }
    if (flags & FLAG_DATA_DESCRIPTOR) {
      throw invalid("zip", `Entry ${where} uses a data descriptor; sizes must be in the local header`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new FormatError("zip", `Entry ${where} uses compression method ${String(method)}`, "unsupported");
    }
    if (madeBy >> 8 === HOST_UNIX) {
      const type = (externalAttributes >>> 16) & UNIX_TYPE_MASK;
      const allowed = name.endsWith("/") ? UNIX_DIRECTORY : UNIX_REGULAR;
      if (type !== 0 && type !== allowed) {
        throw invalid("entry-type", `Entry ${where} is a symlink or special file`);
      }
    }
    if (method === METHOD_STORED ? compressedSize !== size : size > Math.max(compressedSize, 1) * limits.maxCompressionRatio) {
      throw invalid("limit", `Entry ${where} exceeds the compression ratio limit`);
    }
    entries.push({ name, nameBytes, flags, method, crc, compressedSize, size, localOffset, dataOffset: 0 });
  }
  if (pos !== directory.length) {
    throw invalid("zip", "Corrupt central directory");
  }
  return entries;
}

/** Splits an extra field into blocks. Truncated or repeated blocks are ambiguous and rejected. */
function parseExtra(extra: Uint8Array, where: string): Map<number, Uint8Array> {
  const view = viewOf(extra);
  const blocks = new Map<number, Uint8Array>();
  let pos = 0;
  while (pos < extra.length) {
    if (pos + 4 > extra.length) {
      throw invalid("zip", `Corrupt extra field in ${where}`);
    }
    const id = view.getUint16(pos, true);
    const length = view.getUint16(pos + 2, true);
    if (pos + 4 + length > extra.length || blocks.has(id)) {
      throw invalid("zip", `Corrupt extra field in ${where}`);
    }
    if (id === UNICODE_PATH_EXTRA) {
      throw invalid("zip", `Entry ${where} carries a second name in a Unicode Path extra field`);
    }
    blocks.set(id, extra.subarray(pos + 4, pos + 4 + length));
    pos += 4 + length;
  }
  return blocks;
}

/** Sequential reader of a ZIP64 extra block that must be consumed exactly. */
class Zip64Fields {
  private pos = 0;
  private readonly view: DataView | undefined;

  constructor(
    private readonly block: Uint8Array | undefined,
    private readonly where: string,
  ) {
    this.view = block ? viewOf(block) : undefined;
  }

  next64(): number {
    if (!this.view || this.pos + 8 > this.view.byteLength) {
      throw invalid("zip", `Missing ZIP64 field in ${this.where}`);
    }
    const value = uint64(this.view, this.pos);
    this.pos += 8;
    return value;
  }

  next32(): number {
    if (!this.view || this.pos + 4 > this.view.byteLength) {
      throw invalid("zip", `Missing ZIP64 field in ${this.where}`);
    }
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  end(): void {
    if (this.block && this.pos !== this.block.length) {
      throw invalid("zip", `Unexpected ZIP64 fields in ${this.where}`);
    }
  }
}

/** The local header must describe the same entry as the central directory, field by field. */
async function readLocalHeader(source: ByteSource, entry: ZipEntry, directoryOffset: number): Promise<number> {
  const pos = entry.localOffset;
  const where = JSON.stringify(entry.name);
  if (pos + 30 > directoryOffset) {
    throw invalid("zip", `Corrupt local header for ${where}`);
  }
  const fixed = viewOf(await source.read(pos, 30));
  const nameLength = fixed.getUint16(26, true);
  const extraLength = fixed.getUint16(28, true);
  if (fixed.getUint32(0, true) !== LOCAL_HEADER || pos + 30 + nameLength + extraLength > directoryOffset) {
    throw invalid("zip", `Corrupt local header for ${where}`);
  }
  const variable = await source.read(pos + 30, nameLength + extraLength);
  if (!equalBytes(variable.subarray(0, nameLength), entry.nameBytes)) {
    throw invalid("zip", `Local and central names differ for ${where}`);
  }

  // Sizes are either both in the header, or both markers with the values in a ZIP64 block.
  const extra = parseExtra(variable.subarray(nameLength), where);
  const compressedSize32 = fixed.getUint32(18, true);
  const size32 = fixed.getUint32(22, true);
  let size = size32;
  let compressedSize = compressedSize32;
  const zip64 = extra.get(ZIP64_EXTRA);
  if (size32 === MARKER_32 && compressedSize32 === MARKER_32 && zip64?.length === 16) {
    size = uint64(viewOf(zip64), 0);
    compressedSize = uint64(viewOf(zip64), 8);
  } else if (size32 === MARKER_32 || compressedSize32 === MARKER_32 || zip64 !== undefined) {
    throw invalid("zip", `Corrupt ZIP64 sizes in the local header of ${where}`);
  }
  if (
    fixed.getUint16(6, true) !== entry.flags ||
    fixed.getUint16(8, true) !== entry.method ||
    fixed.getUint32(14, true) !== entry.crc ||
    compressedSize !== entry.compressedSize ||
    size !== entry.size
  ) {
    throw invalid("zip", `Local header of ${where} disagrees with the central directory`);
  }
  const dataOffset = pos + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > directoryOffset) {
    throw invalid("zip", `Entry ${where} extends past the central directory`);
  }
  return dataOffset;
}

/**
 * Entries must tile the archive from offset 0 to the central directory: no overlaps (which
 * "overlapping file" ZIP bombs need) and no gaps (where a second, hidden local entry could sit).
 */
function checkContiguous(entries: readonly ZipEntry[], directoryOffset: number): void {
  const ranges = entries
    .map((entry) => ({ start: entry.localOffset, end: entry.dataOffset + entry.compressedSize }))
    .sort((a, b) => a.start - b.start);
  let expected = 0;
  for (const range of ranges) {
    if (range.start !== expected) {
      throw invalid("zip", range.start < expected ? "Entries overlap" : "Unaccounted data between entries");
    }
    expected = range.end;
  }
  if (expected !== directoryOffset) {
    throw invalid("zip", "Unaccounted data before the central directory");
  }
}

/** The compressed bytes of an entry, as stored. */
export function rawChunks(source: ByteSource, entry: ZipEntry, chunkSize = READ_CHUNK_SIZE): AsyncGenerator<Uint8Array> {
  return readChunks(source, entry.dataOffset, entry.compressedSize, chunkSize);
}

/**
 * The uncompressed contents of an entry, chunk by chunk. Throws FormatError as soon as the
 * data grows past its declared size, and at the end if the size or CRC-32 differs.
 */
export async function* entryChunks(source: ByteSource, entry: ZipEntry): AsyncGenerator<Uint8Array> {
  const where = JSON.stringify(entry.name);
  let crc = 0;
  let size = 0;
  const check = (chunk: Uint8Array) => {
    size += chunk.length;
    if (size > entry.size) {
      throw invalid("zip", `Entry ${where} does not match its declared size`);
    }
    crc = crc32(chunk, crc);
  };

  if (entry.method === METHOD_STORED) {
    for await (const chunk of rawChunks(source, entry)) {
      check(chunk);
      yield chunk;
    }
  } else {
    const output: Uint8Array[] = [];
    const inflater = new Inflate((chunk) => {
      output.push(chunk);
    });
    const push = (chunk: Uint8Array, final: boolean) => {
      try {
        inflater.push(chunk, final);
      } catch {
        throw invalid("zip", `Entry ${where} is not valid deflate data`);
      }
    };
    for await (const chunk of rawChunks(source, entry, INFLATE_CHUNK_SIZE)) {
      push(chunk, false);
      yield* drain(output, check);
    }
    push(new Uint8Array(), true);
    yield* drain(output, check);
  }
  if (size !== entry.size) {
    throw invalid("zip", `Entry ${where} does not match its declared size`);
  }
  if (crc !== entry.crc) {
    throw invalid("zip", `Entry ${where} fails its CRC-32 check`);
  }
}

function* drain(output: Uint8Array[], check: (chunk: Uint8Array) => void): Generator<Uint8Array> {
  for (const chunk of output.splice(0)) {
    if (chunk.length > 0) {
      check(chunk);
      yield chunk;
    }
  }
}

/** The whole uncompressed contents of a small entry, checked like {@link entryChunks}. */
export async function readEntry(source: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  const out = new Uint8Array(entry.size);
  let offset = 0;
  for await (const chunk of entryChunks(source, entry)) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Uint8Array, flags: number): string {
  if (!(flags & FLAG_UTF8) && bytes.some((byte) => byte >= 0x80)) {
    throw invalid("entry-name", "Non-ASCII entry names must be flagged as UTF-8");
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw invalid("entry-name", "Entry name is not valid UTF-8");
  }
}

/** Slicing-by-8 tables: table k maps a byte to its CRC contribution k bytes further on. */
const CRC_TABLES = (() => {
  const tables = new Int32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tables[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    for (let k = 1; k < 8; k++) {
      const previous = tables[(k - 1) * 256 + n] as number;
      tables[k * 256 + n] = (previous >>> 8) ^ (tables[previous & 0xff] as number);
    }
  }
  return tables;
})();

/**
 * ZIP's CRC-32 (IEEE 802.3), continuing from `previous` like zlib's `crc32(data, value)`.
 * An integrity check against tool disagreement, not a security hash. Eight bytes per step,
 * several times faster than the byte-wise loop on large documents.
 */
export function crc32(data: Uint8Array, previous = 0): number {
  const t = CRC_TABLES;
  let crc = ~previous;
  let i = 0;
  for (const end = data.length & ~7; i < end; i += 8) {
    const a = ((data[i] as number) | ((data[i + 1] as number) << 8) | ((data[i + 2] as number) << 16) | ((data[i + 3] as number) << 24)) ^ crc;
    const b = (data[i + 4] as number) | ((data[i + 5] as number) << 8) | ((data[i + 6] as number) << 16) | ((data[i + 7] as number) << 24);
    crc =
      (t[1792 + (a & 0xff)] as number) ^
      (t[1536 + ((a >>> 8) & 0xff)] as number) ^
      (t[1280 + ((a >>> 16) & 0xff)] as number) ^
      (t[1024 + (a >>> 24)] as number) ^
      (t[768 + (b & 0xff)] as number) ^
      (t[512 + ((b >>> 8) & 0xff)] as number) ^
      (t[256 + ((b >>> 16) & 0xff)] as number) ^
      (t[b >>> 24] as number);
  }
  for (; i < data.length; i++) {
    crc = (t[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

function uint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid("limit", "ZIP64 value is too large");
  }
  return Number(value);
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function invalid(code: string, message: string): FormatError {
  return new FormatError(code, message);
}
