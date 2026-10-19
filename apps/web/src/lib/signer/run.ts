// The work of the signer worker, apart from the worker itself so it can be tested in Node.js.
import { MEDIA_TYPE, utf8, type ByteSink } from "@docseal/core";
import { createKeyFile, generateSecretKey, KeyFileError, openKeyFile, type KeyFileProgress } from "@docseal/sig-ed25519";
import { sealFiles } from "../seal/seal";
import type { SealOutput, SignerMessage, SignerRequest } from "./protocol";

export class TooLarge extends Error {
  constructor(limit: number) {
    super(`The package would be larger than ${String(limit)} bytes`);
    this.name = "TooLarge";
  }
}

/** Where the package is written, and how to finish or give up. */
interface Output extends ByteSink {
  size(): number;
  /** The finished package: the Blob for memory output. */
  close(): Promise<Blob | undefined>;
  abort(): Promise<void>;
}

async function openOutput(output: SealOutput): Promise<Output> {
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

/** A document that changed or became unreadable after it was chosen. */
function isChanged(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "NotReadableError") || (error instanceof Error && /changed while/.test(error.message));
}

/** Progress is posted at most this often. */
export const PROGRESS_INTERVAL_MS = 100;

/** Holds the one secret key of a worker; it is never posted. */
export class Signer {
  private seed: Uint8Array | undefined;
  private sealing: AbortController | undefined;

  constructor(
    private readonly post: (message: SignerMessage) => void,
    private readonly now: () => number = () => performance.now(),
    /** scrypt cost of a new key; only tests lower it. */
    private readonly scryptN?: number,
  ) {}

  /** The seed, for sealing in this worker (task 8). */
  get secretKey(): Uint8Array | undefined {
    return this.seed;
  }

  async handle(request: SignerRequest): Promise<void> {
    if (request.type === "seal") {
      await this.seal(request);
      return;
    }
    if (request.type === "cancel") {
      this.sealing?.abort();
      return;
    }
    this.forget();
    try {
      if (request.type === "open") {
        const { seed, did } = await openKeyFile(request.keyFile, request.passphrase, this.progress());
        this.seed = seed;
        this.post({ type: "ready", did });
      } else {
        const seed = generateSecretKey();
        const file = await createKeyFile(seed, request.passphrase, { ...this.progress(), ...(this.scryptN !== undefined && { scryptN: this.scryptN }) });
        this.seed = seed;
        // The same file `docseal keygen` writes.
        this.post({ type: "ready", did: file.publicKey, keyFile: utf8(`${JSON.stringify(file, null, 2)}\n`) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = !(error instanceof KeyFileError) ? "other" : /passphrase/i.test(message) && request.type === "open" ? "passphrase" : "file";
      this.post({ type: "failed", reason, message });
    }
  }

  /** Seals once with the key held, then erases it: one key, one sealing. */
  private async seal(request: Extract<SignerRequest, { type: "seal" }>): Promise<void> {
    const secretKey = this.seed;
    if (!secretKey) {
      this.post({ type: "failed", reason: "other", message: "No key is open" });
      return;
    }
    let output: Output | undefined;
    const sealing = new AbortController();
    this.sealing = sealing;
    try {
      output = await openOutput(request.output);
      let last = -Infinity;
      const info = await sealFiles(output, {
        files: request.files,
        secretKey,
        role: request.role,
        signal: sealing.signal,
        onProgress: (read, total) => {
          if (read === total || this.now() - last >= PROGRESS_INTERVAL_MS) {
            last = this.now();
            this.post({ type: "seal-progress", read, total });
          }
        },
      });
      const blob = await output.close();
      this.forget();
      this.post({ type: "sealed", seal: info.seal, packageId: info.manifest.packageId, size: output.size(), ...(blob && { blob }) });
    } catch (error) {
      this.forget();
      await output?.abort().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const reason = sealing.signal.aborted ? "cancelled" : error instanceof TooLarge ? "too-large" : isChanged(error) ? "changed" : "other";
      this.post({ type: "failed", reason, message });
    } finally {
      this.sealing = undefined;
    }
  }

  /** Overwrites the seed. The worker is terminated after one sealing anyway. */
  forget(): void {
    this.seed?.fill(0);
    this.seed = undefined;
  }

  private progress(): KeyFileProgress {
    let last = -Infinity;
    return {
      onProgress: (share) => {
        if (share === 1 || this.now() - last >= PROGRESS_INTERVAL_MS) {
          last = this.now();
          this.post({ type: "key-progress", share });
        }
      },
    };
  }
}
