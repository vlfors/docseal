// The work of the signer worker, apart from the worker itself so it can be tested in Node.js.
import { openTimestamps, type Fetch } from "@docseal/anchor-ots";
import { utf8, type AnchorProvider } from "@docseal/core";
import { createKeyFile, generateSecretKey, KeyFileError, openKeyFile, type KeyFileProgress } from "@docseal/sig-ed25519";
import { sealFiles } from "../seal/seal";
import { BROWSER_CALENDARS } from "../../../network.js";
import { browserFetch } from "../network";
import { openOutput, TooLarge, type Output } from "../output";
import type { SignerMessage, SignerRequest } from "./protocol";

/** Too few calendars accepted the seal: sealing stops before anything is written. */
class CalendarsFailed extends Error {
  override name = "CalendarsFailed";
}

/** OpenTimestamps over the calendars a browser can reach, and the ones that accepted. */
function timestamping(base?: Fetch): { provider: AnchorProvider; accepted: readonly string[] } {
  const fetch = browserFetch(base);
  const provider = openTimestamps({ calendars: BROWSER_CALENDARS, fetch });
  return {
    provider: {
      ...provider,
      submit: (digest) =>
        provider.submit(digest).catch((error: unknown) => {
          throw new CalendarsFailed(error instanceof Error ? error.message : String(error));
        }),
    },
    accepted: fetch.acceptedCalendars,
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
    /** The network; only tests replace it. */
    private readonly fetch?: Fetch,
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
      const anchor = request.timestamp ? timestamping(this.fetch) : undefined;
      const info = await sealFiles(output, {
        files: request.files,
        secretKey,
        role: request.role,
        signal: sealing.signal,
        ...(anchor && { anchors: [anchor.provider] }),
        onProgress: (read, total) => {
          if (read === total || this.now() - last >= PROGRESS_INTERVAL_MS) {
            last = this.now();
            this.post({ type: "seal-progress", read, total });
          }
        },
      });
      const blob = await output.close();
      this.forget();
      this.post({
        type: "sealed",
        seal: info.seal,
        packageId: info.manifest.packageId,
        size: output.size(),
        calendars: [...(anchor?.accepted ?? [])],
        ...(blob && { blob }),
      });
    } catch (error) {
      this.forget();
      await output?.abort().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const reason = sealing.signal.aborted
        ? "cancelled"
        : error instanceof TooLarge
          ? "too-large"
          : error instanceof CalendarsFailed
            ? "calendars"
            : isChanged(error)
              ? "changed"
              : "other";
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
