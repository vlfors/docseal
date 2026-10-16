/**
 * Reading and writing the `.dseal` ZIP container (FORMAT-v0.1 §Container).
 *
 * The central directory is parsed here rather than by a general-purpose unzip routine,
 * because safe extraction needs what those hide: duplicate names, Unix file types
 * (symlinks), overlapping entries, and declared sizes before anything is inflated.
 * fflate is only used to deflate and inflate individual entries.
 */
import { inflateSync, zipSync, type Zippable } from "fflate";
import { equalBytes, utf8 } from "./bytes.js";
import { FormatError } from "./errors.js";
import { MEDIA_TYPE } from "./constants.js";
import { checkPathCollisions, validatePath } from "./paths.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export interface ContainerLimits {
  maxEntries: number;
  maxDocumentSize: number;
  maxTotalDocumentSize: number;
  maxJsonSize: number;
  /** Maximum ratio of uncompressed to compressed size of a single entry. */
  maxCompressionRatio: number;
}

export const DEFAULT_LIMITS: Readonly<ContainerLimits> = {
  maxEntries: 10_100,
  maxDocumentSize: 4 * GiB,
  maxTotalDocumentSize: 16 * GiB,
  maxJsonSize: 16 * MiB,
  maxCompressionRatio: 1000,
};

export interface PackageContents {
  manifest: Uint8Array;
  statement: Uint8Array;
  /** Documents keyed by manifest path (without the `files/` prefix). */
  files: Map<string, Uint8Array>;
  /** Envelopes keyed by entry name, e.g. `signatures/0001.json`. */
  signatures: Map<string, Uint8Array>;
  /** Anchor files keyed by entry name, e.g. `anchors/seal-1.json`. */
  anchors: Map<string, Uint8Array>;
}

const SIGNATURE_NAME = /^signatures\/\d{4,}\.json$/;
const ANCHOR_NAME = /^anchors\/seal-[1-9]\d*\.json$/;
// Entries are timestamped with the DOS epoch so the same contents give the same container bytes.
const FIXED_MTIME = new Date(1980, 0, 1);

export function writeContainer(contents: PackageContents): Uint8Array {
  const entries: Zippable = {
    mimetype: [utf8(MEDIA_TYPE), { level: 0 }],
    "manifest.json": contents.manifest,
    "statement.json": contents.statement,
  };
  for (const [path, data] of contents.files) {
    entries[`files/${path}`] = data;
  }
  for (const [name, data] of [...contents.signatures, ...contents.anchors]) {
    entries[name] = data;
  }
  return zipSync(entries, { mtime: FIXED_MTIME });
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const HOST_UNIX = 3;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_REGULAR = 0o100000;
const UNIX_DIRECTORY = 0o040000;

interface CentralEntry {
  name: string;
  nameBytes: Uint8Array;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  dataOffset: number;
}

type EntryKind =
  | { kind: "mimetype" | "manifest" | "statement" | "directory" }
  | { kind: "file"; path: string }
  | { kind: "signature" | "anchor"; name: string };

export function readContainer(zip: Uint8Array, limits: ContainerLimits = DEFAULT_LIMITS): PackageContents {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = readCentralDirectory(zip, view, limits);

  const first = entries[0];
  if (first?.name !== "mimetype" || first.method !== METHOD_STORED || first.localOffset !== 0) {
    throw invalid("mimetype", "'mimetype' must be the first entry, stored without compression");
  }

  const contents: Partial<PackageContents> & Pick<PackageContents, "files" | "signatures" | "anchors"> = {
    files: new Map(),
    signatures: new Map(),
    anchors: new Map(),
  };
  let totalDocumentSize = 0;
  for (const entry of entries) {
    const target = classify(entry.name);
    const maxSize = target.kind === "file" ? limits.maxDocumentSize : limits.maxJsonSize;
    if (entry.size > maxSize) {
      throw invalid("limit", `Entry ${JSON.stringify(entry.name)} exceeds the size limit`);
    }
    if (target.kind === "file") {
      totalDocumentSize += entry.size;
      if (totalDocumentSize > limits.maxTotalDocumentSize) {
        throw invalid("limit", "Documents exceed the total size limit");
      }
    }
    if (target.kind === "directory") {
      if (entry.size !== 0) {
        throw invalid("entry", `Directory entry ${JSON.stringify(entry.name)} has contents`);
      }
      continue;
    }
    const data = extract(zip, entry, limits);
    switch (target.kind) {
      case "mimetype":
        if (!equalBytes(data, utf8(MEDIA_TYPE))) {
          throw invalid("mimetype", `'mimetype' must contain ${MEDIA_TYPE}`);
        }
        break;
      case "manifest":
        contents.manifest = data;
        break;
      case "statement":
        contents.statement = data;
        break;
      case "file":
        contents.files.set(target.path, data);
        break;
      case "signature":
        contents.signatures.set(target.name, data);
        break;
      case "anchor":
        contents.anchors.set(target.name, data);
        break;
    }
  }
  if (!contents.manifest || !contents.statement) {
    throw invalid("missing-entry", "'manifest.json' and 'statement.json' are required");
  }
  checkPathCollisions(contents.files.keys());
  return contents as PackageContents;
}

function readCentralDirectory(zip: Uint8Array, view: DataView, limits: ContainerLimits): CentralEntry[] {
  const end = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const entriesOnDisk = view.getUint16(end + 8, true);
  const totalEntries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);

  if (totalEntries === ZIP64_MARKER_16 || directorySize === ZIP64_MARKER_32 || directoryOffset === ZIP64_MARKER_32) {
    throw zip64();
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw invalid("zip", "Multi-disk archives are not supported");
  }
  if (totalEntries > limits.maxEntries) {
    throw invalid("limit", `More than ${String(limits.maxEntries)} entries`);
  }
  if (directoryOffset + directorySize !== end) {
    throw invalid("zip", "Unexpected data around the central directory");
  }

  const entries: CentralEntry[] = [];
  const names = new Set<string>();
  let pos = directoryOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== CENTRAL_HEADER) {
      throw invalid("zip", "Corrupt central directory");
    }
    const madeBy = view.getUint16(pos + 4, true);
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const externalAttributes = view.getUint32(pos + 38, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameBytes = zip.subarray(pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;
    if (pos > end) {
      throw invalid("zip", "Corrupt central directory");
    }

    const name = decodeName(nameBytes, flags);
    if (names.has(name)) {
      throw invalid("duplicate-entry", `Duplicate entry ${JSON.stringify(name)}`);
    }
    names.add(name);
    if (compressedSize === ZIP64_MARKER_32 || size === ZIP64_MARKER_32 || localOffset === ZIP64_MARKER_32) {
      throw zip64();
    }
    if (flags & FLAG_ENCRYPTED) {
      throw invalid("zip", `Entry ${JSON.stringify(name)} is encrypted`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new FormatError("zip", `Entry ${JSON.stringify(name)} uses compression method ${String(method)}`, "unsupported");
    }
    if (madeBy >> 8 === HOST_UNIX) {
      const type = (externalAttributes >>> 16) & UNIX_TYPE_MASK;
      const allowed = name.endsWith("/") ? UNIX_DIRECTORY : UNIX_REGULAR;
      if (type !== 0 && type !== allowed) {
        throw invalid("entry-type", `Entry ${JSON.stringify(name)} is a symlink or special file`);
      }
    }
    if (method === METHOD_STORED ? compressedSize !== size : size > Math.max(compressedSize, 1) * limits.maxCompressionRatio) {
      throw invalid("limit", `Entry ${JSON.stringify(name)} exceeds the compression ratio limit`);
    }

    entries.push({ name, nameBytes, method, compressedSize, size, localOffset, dataOffset: 0 });
  }
  if (pos !== end) {
    throw invalid("zip", "Corrupt central directory");
  }

  for (const entry of entries) {
    entry.dataOffset = readLocalHeader(view, zip, entry, directoryOffset);
  }
  checkNoOverlap(entries);
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let pos = view.byteLength - 22; pos >= minimum; pos--) {
    if (view.getUint32(pos, true) === END_OF_CENTRAL_DIRECTORY && pos + 22 + view.getUint16(pos + 20, true) === view.byteLength) {
      return pos;
    }
  }
  throw invalid("zip", "Not a ZIP archive");
}

function readLocalHeader(view: DataView, zip: Uint8Array, entry: CentralEntry, directoryOffset: number): number {
  const pos = entry.localOffset;
  if (pos + 30 > directoryOffset || view.getUint32(pos, true) !== LOCAL_HEADER) {
    throw invalid("zip", `Corrupt local header for ${JSON.stringify(entry.name)}`);
  }
  const nameLength = view.getUint16(pos + 26, true);
  const extraLength = view.getUint16(pos + 28, true);
  const localName = zip.subarray(pos + 30, pos + 30 + nameLength);
  if (!equalBytes(localName, entry.nameBytes)) {
    throw invalid("zip", `Local and central names differ for ${JSON.stringify(entry.name)}`);
  }
  const dataOffset = pos + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > directoryOffset) {
    throw invalid("zip", `Entry ${JSON.stringify(entry.name)} extends past the central directory`);
  }
  return dataOffset;
}

/** Overlapping entries are how "overlapping file" ZIP bombs reuse one compressed stream many times. */
function checkNoOverlap(entries: readonly CentralEntry[]): void {
  const ranges = entries
    .map((entry) => ({ start: entry.localOffset, end: entry.dataOffset + entry.compressedSize }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous && current && current.start < previous.end) {
      throw invalid("zip", "Entries overlap");
    }
  }
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

function classify(name: string): EntryKind {
  switch (name) {
    case "mimetype":
      return { kind: "mimetype" };
    case "manifest.json":
      return { kind: "manifest" };
    case "statement.json":
      return { kind: "statement" };
    case "files/":
    case "signatures/":
    case "anchors/":
      return { kind: "directory" };
  }
  if (name.startsWith("files/")) {
    const path = name.slice("files/".length);
    if (path.endsWith("/")) {
      validatePath(path.slice(0, -1));
      return { kind: "directory" };
    }
    validatePath(path);
    return { kind: "file", path };
  }
  if (SIGNATURE_NAME.test(name)) {
    return { kind: "signature", name };
  }
  if (ANCHOR_NAME.test(name)) {
    return { kind: "anchor", name };
  }
  throw invalid("unexpected-entry", `Unexpected entry ${JSON.stringify(name)}`);
}

function extract(zip: Uint8Array, entry: CentralEntry, limits: ContainerLimits): Uint8Array {
  const raw = zip.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === METHOD_STORED) {
    return raw.slice();
  }
  // One spare byte: fflate silently truncates at the buffer end, so a result longer
  // than the declared size shows up as `size + 1` without allocating more.
  let data: Uint8Array;
  try {
    data = inflateSync(raw, { out: new Uint8Array(entry.size + 1) });
  } catch {
    throw invalid("zip", `Entry ${JSON.stringify(entry.name)} is not valid deflate data`);
  }
  if (data.length !== entry.size || data.length > Math.max(raw.length, 1) * limits.maxCompressionRatio) {
    throw invalid("zip", `Entry ${JSON.stringify(entry.name)} does not match its declared size`);
  }
  return data;
}

function invalid(code: string, message: string): FormatError {
  return new FormatError(code, message);
}

function zip64(): FormatError {
  return new FormatError("zip64", "ZIP64 archives are not supported yet", "unsupported");
}
