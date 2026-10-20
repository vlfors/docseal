// Sealing in the signer worker: the chosen files, read slice by slice, signed with the key the
// worker holds, written to a sink. Apart from the worker so the browser tests can run it with
// fixed time and randomness and compare the bytes with Node.js.
import { blobSource, sealPackageTo, type AnchorProvider, type ByteSink, type ByteSource, type SealInfo } from "@docseal/core";
import { memoryKeyProvider } from "@docseal/sig-ed25519";
import { version } from "../../../package.json";

export const GENERATOR = `docseal-web/${version}`;

/** The steps of a sealing, in order; `timestamping` only with anchors. */
export type SealStage = "hashing" | "signing" | "timestamping" | "writing";

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
  /** Called as each step begins. */
  onStage?: (stage: SealStage) => void;
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
  const stage = (next: SealStage) => options.onStage?.(next);
  const anchors = options.anchors?.length ? options.anchors : undefined;
  const key = memoryKeyProvider(options.secretKey);
  // The steps are seen from the outside: signing is the key's one call, after every document is
  // hashed; then the seal goes to the anchors, if any; then the documents are read again to write.
  const signer: typeof key = {
    ...key,
    getSigner: () => key.getSigner(),
    async sign(bytes) {
      stage("signing");
      const signature = await key.sign(bytes);
      if (!anchors) {
        stage("writing");
      }
      return signature;
    },
  };
  let submitting = 0;
  const watched = anchors?.map((provider) => ({
    ...provider,
    async submit(digest: Uint8Array) {
      if (submitting++ === 0) {
        stage("timestamping");
      }
      const receipt = await provider.submit(digest);
      if (--submitting === 0) {
        stage("writing");
      }
      return receipt;
    },
  }));
  stage("hashing");
  return sealPackageTo(sink, {
    files: options.files.map(({ path, file }) => ({ path, source: counted(blobSource(file), report) })),
    signer,
    generator: GENERATOR,
    ...(options.role !== undefined && options.role !== "" && { role: options.role }),
    ...(watched && { anchors: watched }),
    ...(options.now && { now: options.now }),
    ...(options.randomBytes && { randomBytes: options.randomBytes }),
  });
}
