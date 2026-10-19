// Sealing in the signer worker: the chosen files, read slice by slice, signed with the key the
// worker holds, written to a sink. Apart from the worker so the browser tests can run it with
// fixed time and randomness and compare the bytes with Node.js.
import { blobSource, sealPackageTo, type AnchorProvider, type ByteSink, type ByteSource, type SealInfo } from "@docseal/core";
import { memoryKeyProvider } from "@docseal/sig-ed25519";
import { version } from "../../../package.json";

export const GENERATOR = `docseal-web/${version}`;

export interface SealRequestFile {
  path: string;
  file: Blob;
}

export interface SealFilesOptions {
  files: readonly SealRequestFile[];
  secretKey: Uint8Array;
  role?: string;
  anchors?: readonly AnchorProvider[];
  /** Bytes of the documents read so far, and the total: each document is read twice. */
  onProgress?: (read: number, total: number) => void;
  /** Stops sealing at the next read of a document. */
  signal?: AbortSignal;
  /** Injected only by tests. */
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}

/** `source`, reporting the bytes read through it. */
function counted(source: ByteSource, onRead: (bytes: number) => void): ByteSource {
  return {
    size: source.size,
    async read(offset, length) {
      const bytes = await source.read(offset, length);
      onRead(bytes.length);
      return bytes;
    },
  };
}

export async function sealFiles(sink: ByteSink, options: SealFilesOptions): Promise<SealInfo> {
  // Sealing reads each document twice: once for its hash and CRC, once to write it.
  const total = 2 * options.files.reduce((sum, { file }) => sum + file.size, 0);
  let read = 0;
  const report = (bytes: number) => {
    options.signal?.throwIfAborted();
    read = Math.min(total, read + bytes);
    options.onProgress?.(read, total);
  };
  return sealPackageTo(sink, {
    files: options.files.map(({ path, file }) => ({ path, source: counted(blobSource(file), report) })),
    signer: memoryKeyProvider(options.secretKey),
    generator: GENERATOR,
    ...(options.role !== undefined && options.role !== "" && { role: options.role }),
    ...(options.anchors && { anchors: options.anchors }),
    ...(options.now && { now: options.now }),
    ...(options.randomBytes && { randomBytes: options.randomBytes }),
  });
}
