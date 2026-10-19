// The work of the signer worker, apart from the worker itself so it can be tested in Node.js.
import { utf8 } from "@docseal/core";
import { createKeyFile, generateSecretKey, KeyFileError, openKeyFile, type KeyFileProgress } from "@docseal/sig-ed25519";
import type { SignerMessage, SignerRequest } from "./protocol";

/** Progress is posted at most this often. */
export const PROGRESS_INTERVAL_MS = 100;

/** Holds the one secret key of a worker; it is never posted. */
export class Signer {
  private seed: Uint8Array | undefined;

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
