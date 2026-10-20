// Where a worker writes a package it makes (sealing, upgrading): a file picked with
// showSaveFilePicker, written as it is produced, or memory, handed back as one Blob.
import { MEDIA_TYPE, type ByteSink } from "@docseal/core";

/** A picked file (Chrome, Edge), or memory of at most `limit` bytes (elsewhere). */
export type PackageOutput = { kind: "file"; handle: FileSystemFileHandle } | { kind: "memory"; limit: number };

export class TooLarge extends Error {
  constructor(limit: number) {
    super(`The package would be larger than ${String(limit)} bytes`);
    this.name = "TooLarge";
  }
}

/** Where the package is written, and how to finish or give up. */
export interface Output extends ByteSink {
  size(): number;
  /** The finished package: the Blob for memory output. */
  close(): Promise<Blob | undefined>;
  abort(): Promise<void>;
}

export async function openOutput(output: PackageOutput): Promise<Output> {
  let size = 0;
  if (output.kind === "file") {
    // Written to a swap file and moved into place by close(); abort() leaves the file untouched.
    const writable = await output.handle.createWritable();
    return {
      async write(chunk) {
        size += chunk.length;
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
      },
      size: () => size,
      async close() {
        await writable.close();
        return undefined;
      },
      abort: () => writable.abort(),
    };
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  return {
    write(chunk) {
      size += chunk.length;
      if (size > output.limit) {
        return Promise.reject(new TooLarge(output.limit));
      }
      chunks.push(chunk.slice());
      return Promise.resolve();
    },
    size: () => size,
    close: () => Promise.resolve(new Blob(chunks, { type: MEDIA_TYPE })),
    abort: () => {
      chunks.length = 0;
      return Promise.resolve();
    },
  };
}

