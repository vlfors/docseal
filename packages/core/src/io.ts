/**
 * Byte sources and sinks, so packages and documents never have to sit in memory whole.
 * The core stays independent of the runtime: Node files, browser Blobs, and plain byte
 * arrays all fit behind these two small interfaces.
 */

/** Random-access input of a known size: a package file, a document, a Blob. */
export interface ByteSource {
  readonly size: number;
  /** Returns exactly `length` bytes starting at `offset`, or throws. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Sequential output. */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
}

/** Reads of documents and stored entries; large enough to keep per-call overhead negligible. */
export const READ_CHUNK_SIZE = 1024 * 1024;

export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.length) {
        return Promise.reject(new RangeError("Read past the end of the data"));
      }
      return Promise.resolve(bytes.subarray(offset, offset + length));
    },
  };
}

/** A Blob or File, read slice by slice (browsers, and Node 18+). */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      if (bytes.length !== length) {
        throw new RangeError("Read past the end of the data");
      }
      return bytes;
    },
  };
}

export interface MemorySink extends ByteSink {
  /** Everything written so far, as one array. */
  bytes(): Uint8Array;
}

export function memorySink(): MemorySink {
  const chunks: Uint8Array[] = [];
  let length = 0;
  return {
    write(chunk) {
      chunks.push(chunk.slice());
      length += chunk.length;
      return Promise.resolve();
    },
    bytes() {
      const out = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
  };
}

/** Reads `length` bytes from `offset` in chunks of at most `chunkSize`. */
export async function* readChunks(
  source: ByteSource,
  offset = 0,
  length = source.size - offset,
  chunkSize = READ_CHUNK_SIZE,
): AsyncGenerator<Uint8Array> {
  const end = offset + length;
  for (let pos = offset; pos < end; pos += chunkSize) {
    const size = Math.min(chunkSize, end - pos);
    const chunk = await source.read(pos, size);
    if (chunk.length !== size) {
      throw new RangeError(`Short read: expected ${String(size)} bytes, got ${String(chunk.length)}`);
    }
    yield chunk;
  }
}

/** Collects a whole source; for small entries only. */
export async function readAll(source: ByteSource): Promise<Uint8Array> {
  return source.size === 0 ? new Uint8Array() : source.read(0, source.size);
}
