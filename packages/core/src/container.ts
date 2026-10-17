/**
 * The `.dseal` container (FORMAT-v0.1 §Container): which entries may exist, limits, and the
 * order they are written in. ZIP details live in zip.ts and zip-writer.ts.
 *
 * Small JSON entries are read into memory; documents are only ever streamed, so packages
 * larger than memory can be verified.
 */
import { equalBytes, utf8 } from "./bytes.js";
import { MEDIA_TYPE } from "./constants.js";
import { FormatError } from "./errors.js";
import { bytesSource, memorySink, readAll, readChunks, type ByteSink, type ByteSource } from "./io.js";
import { checkPathCollisions, validatePath } from "./paths.js";
import { entryChunks, rawChunks, readEntry, readZipDirectory, METHOD_STORED, type ZipEntry } from "./zip.js";
import { ZipWriter, type ZipWriterOptions } from "./zip-writer.js";

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
  maxDocumentSize: 16 * GiB,
  maxTotalDocumentSize: 64 * GiB,
  maxJsonSize: 16 * MiB,
  maxCompressionRatio: 1000,
};

/** Documents up to this size are deflated in memory when sealing; larger ones are stored and streamed. */
export const COMPRESS_MAX_SIZE = 8 * MiB;

/** A document inside an opened container. Its contents are read only when asked for. */
export interface DocumentEntry {
  /** Manifest path, without the `files/` prefix. */
  readonly path: string;
  /** Declared uncompressed size. */
  readonly size: number;
  /**
   * The contents, chunk by chunk. Throws FormatError if they turn out longer or shorter than
   * declared, or fail the CRC-32 check, so a consumer must read to the end.
   */
  chunks(): AsyncIterable<Uint8Array>;
}

export interface Container {
  manifest: Uint8Array;
  statement: Uint8Array;
  /** Documents keyed by manifest path, in container order. */
  files: ReadonlyMap<string, DocumentEntry>;
  /** Envelopes keyed by entry name, e.g. `signatures/0001.json`. */
  signatures: Map<string, Uint8Array>;
  /** Anchor files keyed by entry name, e.g. `anchors/seal-1.json`. */
  anchors: Map<string, Uint8Array>;
}

/** A container read wholly into memory: for small packages and tests. */
export interface PackageContents {
  manifest: Uint8Array;
  statement: Uint8Array;
  files: Map<string, Uint8Array>;
  signatures: Map<string, Uint8Array>;
  anchors: Map<string, Uint8Array>;
}

type EntryKind =
  | { kind: "mimetype" | "manifest" | "statement" | "directory" }
  | { kind: "file"; path: string }
  | { kind: "signature" | "anchor"; name: string };

const SIGNATURE_NAME = /^signatures\/[0-9]{4,}\.json$/;
const ANCHOR_NAME = /^anchors\/seal-[1-9][0-9]*\.json$/;

/** Where an opened container came from, for copying its entries without recompressing them. */
const origins = new WeakMap<Container, { source: ByteSource; entries: readonly ZipEntry[] }>();

/**
 * Checks the whole structure and reads the JSON entries. Documents are not read: their
 * contents are checked when {@link DocumentEntry.chunks} is consumed.
 */
export async function openContainer(source: ByteSource, limits: ContainerLimits = DEFAULT_LIMITS): Promise<Container> {
  const entries = await readZipDirectory(source, limits);

  const first = entries[0];
  if (first?.name !== "mimetype" || first.method !== METHOD_STORED || first.localOffset !== 0) {
    throw invalid("mimetype", "'mimetype' must be the first entry, stored without compression");
  }

  // Classify and check every declared size before reading anything.
  const targets = entries.map((entry) => ({ entry, target: classify(entry.name) }));
  let totalDocumentSize = 0;
  for (const { entry, target } of targets) {
    const maxSize = target.kind === "file" ? limits.maxDocumentSize : limits.maxJsonSize;
    if (entry.size > maxSize) {
      throw invalid("limit", `Entry ${JSON.stringify(entry.name)} exceeds the size limit`);
    }
    if (target.kind === "file") {
      totalDocumentSize += entry.size;
    }
    if (target.kind === "directory" && entry.size !== 0) {
      throw invalid("entry", `Directory entry ${JSON.stringify(entry.name)} has contents`);
    }
  }
  if (totalDocumentSize > limits.maxTotalDocumentSize) {
    throw invalid("limit", "Documents exceed the total size limit");
  }

  let manifest: Uint8Array | undefined;
  let statement: Uint8Array | undefined;
  const files = new Map<string, DocumentEntry>();
  const signatures = new Map<string, Uint8Array>();
  const anchors = new Map<string, Uint8Array>();
  for (const { entry, target } of targets) {
    switch (target.kind) {
      case "directory":
        break;
      case "file":
        files.set(target.path, { path: target.path, size: entry.size, chunks: () => entryChunks(source, entry) });
        break;
      case "mimetype":
        if (!equalBytes(await readEntry(source, entry), utf8(MEDIA_TYPE))) {
          throw invalid("mimetype", `'mimetype' must contain ${MEDIA_TYPE}`);
        }
        break;
      case "manifest":
        manifest = await readEntry(source, entry);
        break;
      case "statement":
        statement = await readEntry(source, entry);
        break;
      case "signature":
        signatures.set(target.name, await readEntry(source, entry));
        break;
      case "anchor":
        anchors.set(target.name, await readEntry(source, entry));
        break;
    }
  }
  if (!manifest || !statement) {
    throw invalid("missing-entry", "'manifest.json' and 'statement.json' are required");
  }
  checkPathCollisions(files.keys());
  const container: Container = { manifest, statement, files, signatures, anchors };
  origins.set(container, { source, entries });
  return container;
}

/** Reads a whole container into memory, checking every document. */
export async function readContainer(zip: Uint8Array, limits: ContainerLimits = DEFAULT_LIMITS): Promise<PackageContents> {
  const container = await openContainer(bytesSource(zip), limits);
  const files = new Map<string, Uint8Array>();
  for (const [path, entry] of container.files) {
    const parts: Uint8Array[] = [];
    for await (const chunk of entry.chunks()) {
      parts.push(chunk);
    }
    files.set(path, concat(parts, entry.size));
  }
  return { ...container, files };
}

/** A document to write: its size and CRC-32 must be known before its contents are streamed. */
export interface DocumentSource {
  path: string;
  source: ByteSource;
  crc: number;
}

export interface ContainerParts {
  manifest: Uint8Array;
  statement: Uint8Array;
  documents: readonly DocumentSource[];
  signatures: ReadonlyMap<string, Uint8Array>;
  anchors: ReadonlyMap<string, Uint8Array>;
}

/**
 * Writes a container: mimetype, manifest, statement, documents, signatures, anchors.
 * Documents up to {@link COMPRESS_MAX_SIZE} are deflated when that helps; larger ones are
 * stored and streamed, so their size never matters for memory.
 */
export async function writeContainerTo(sink: ByteSink, parts: ContainerParts, options: ZipWriterOptions = {}): Promise<void> {
  const zip = new ZipWriter(sink, options);
  await writeHead(zip, parts.manifest, parts.statement);
  for (const document of parts.documents) {
    const name = `files/${document.path}`;
    if (document.source.size <= COMPRESS_MAX_SIZE) {
      await zip.add(name, await readAll(document.source), { compress: true, crc: document.crc });
    } else {
      await zip.addStored(name, document.source.size, document.crc, readChunks(document.source));
    }
  }
  await writeTail(zip, parts.signatures, parts.anchors);
  await zip.finish();
}

/** In-memory counterpart of {@link writeContainerTo}. */
export async function writeContainer(contents: PackageContents, options: ZipWriterOptions = {}): Promise<Uint8Array> {
  const sink = memorySink();
  const zip = new ZipWriter(sink, options);
  await writeHead(zip, contents.manifest, contents.statement);
  for (const [path, data] of contents.files) {
    await zip.add(`files/${path}`, data, { compress: true });
  }
  await writeTail(zip, contents.signatures, contents.anchors);
  await zip.finish();
  return sink.bytes();
}

/**
 * Writes an opened container again with different anchor files, copying every other entry's
 * compressed bytes unchanged. Anchors are outside the signed state, so this is all `upgrade` needs.
 */
export async function rewriteAnchors(
  container: Container,
  anchors: ReadonlyMap<string, Uint8Array>,
  sink: ByteSink,
  options: ZipWriterOptions = {},
): Promise<void> {
  const origin = origins.get(container);
  if (!origin) {
    throw new Error("Container was not opened with openContainer");
  }
  const zip = new ZipWriter(sink, options);
  for (const entry of origin.entries) {
    const replacement = anchors.get(entry.name);
    if (replacement) {
      await zip.add(entry.name, replacement, { compress: true });
    } else {
      await zip.addRaw(entry.name, entry, rawChunks(origin.source, entry));
    }
  }
  await zip.finish();
}

async function writeHead(zip: ZipWriter, manifest: Uint8Array, statement: Uint8Array): Promise<void> {
  await zip.add("mimetype", utf8(MEDIA_TYPE), { compress: false });
  await zip.add("manifest.json", manifest, { compress: true });
  await zip.add("statement.json", statement, { compress: true });
}

async function writeTail(
  zip: ZipWriter,
  signatures: ReadonlyMap<string, Uint8Array>,
  anchors: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  for (const [name, data] of [...signatures, ...anchors]) {
    await zip.add(name, data, { compress: true });
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

function concat(parts: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function invalid(code: string, message: string): FormatError {
  return new FormatError(code, message);
}

export { crc32 } from "./zip.js";
