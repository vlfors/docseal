// The page's side of a key: a worker that holds it. The page only ever learns the public key.
import type { SealRequestFile } from "../seal/seal";
import type { SealOutput, SignerMessage, SignerRequest } from "./protocol";

export class KeyError extends Error {
  constructor(
    readonly reason: "passphrase" | "file" | "cancelled" | "other",
    message: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

export interface OpenKey {
  readonly did: string;
  /** For a new key: the encrypted key file, to be saved at once. */
  readonly keyFile?: Uint8Array;
  /** The worker that holds the key; sealing (task 8) talks to it. */
  readonly worker: Worker;
  /** Erases the key: the worker is terminated. */
  close(): void;
}

export interface KeyTask {
  readonly result: Promise<OpenKey>;
  /** Stops deriving the key and erases anything derived so far. */
  cancel(): void;
}

function start(request: SignerRequest, onProgress?: (share: number) => void): KeyTask {
  const worker = new Worker(new URL("./signer.worker.ts", import.meta.url), { type: "module" });
  let settle: { resolve: (key: OpenKey) => void; reject: (error: Error) => void } | undefined;
  const result = new Promise<OpenKey>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const fail = (error: Error) => {
    if (settle) {
      settle.reject(error);
      settle = undefined;
      worker.terminate();
    }
  };
  worker.onmessage = (event: MessageEvent<SignerMessage>) => {
    const message = event.data;
    if (!settle) {
      return;
    }
    switch (message.type) {
      case "key-progress":
        onProgress?.(message.share);
        break;
      case "ready": {
        // Later messages (sealing progress) are the sealing's to handle.
        worker.onmessage = null;
        settle.resolve({
          did: message.did,
          ...(message.keyFile && { keyFile: message.keyFile }),
          worker,
          close: () => {
            worker.terminate();
          },
        });
        settle = undefined;
        break;
      }
      case "failed":
        fail(new KeyError(message.reason === "passphrase" || message.reason === "file" ? message.reason : "other", message.message));
        break;
      default:
        break;
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(new KeyError("other", event.message || "The key worker failed"));
  };
  worker.postMessage(request);
  return {
    result,
    cancel() {
      fail(new KeyError("cancelled", "Cancelled"));
    },
  };
}

/** Opens a key file (`docseal keygen`'s format) with its passphrase, in a worker. */
export function openKey(keyFile: Uint8Array, passphrase: string, onProgress?: (share: number) => void): KeyTask {
  return start({ type: "open", keyFile, passphrase }, onProgress);
}

/** Makes a new key in a worker, encrypted with `passphrase`. */
export function generateKey(passphrase: string, onProgress?: (share: number) => void): KeyTask {
  return start({ type: "generate", passphrase }, onProgress);
}

export class SealError extends Error {
  constructor(
    readonly reason: "changed" | "too-large" | "calendars" | "cancelled" | "other",
    message: string,
  ) {
    super(message);
    this.name = "SealError";
  }
}

export interface Sealed {
  seal: string;
  packageId: string;
  size: number;
  /** Origins of the calendars that accepted the seal; empty without a time proof. */
  calendars: string[];
  /** The package, for memory output; with file output it is already in the picked file. */
  blob?: Blob;
}

export interface SealTask {
  readonly result: Promise<Sealed>;
  /** Settles `result` at once as cancelled; the worker aborts its output, then is terminated. */
  cancel(): void;
  /** Resolves once the worker is terminated and the key erased, however the sealing ended. */
  readonly stopped: Promise<void>;
}

/** How long a cancelled worker may take to release its output before it is terminated anyway. */
const CANCEL_GRACE_MS = 5000;

/**
 * Seals the documents with an open key. This is the key's one sealing: when it ends, in any
 * way, the worker is terminated and the key erased; sealing again needs the key opened again.
 */
export function sealWithKey(
  key: OpenKey,
  files: SealRequestFile[],
  role: string,
  output: SealOutput,
  timestamp: boolean,
  onProgress?: (read: number, total: number) => void,
): SealTask {
  let settle: { resolve: (sealed: Sealed) => void; reject: (error: Error) => void } | undefined;
  const result = new Promise<Sealed>((resolve, reject) => {
    settle = { resolve, reject };
  });
  let markStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    markStopped = resolve;
  });
  const stop = () => {
    key.close();
    markStopped();
  };
  /** Settles the result once; `keepWorker` leaves the worker to finish aborting its output. */
  const finish = (outcome: { sealed: Sealed } | { error: Error }, keepWorker = false) => {
    if (!settle) {
      return;
    }
    const { resolve, reject } = settle;
    settle = undefined;
    if (!keepWorker) {
      stop();
    }
    if ("sealed" in outcome) {
      resolve(outcome.sealed);
    } else {
      reject(outcome.error);
    }
  };
  key.worker.onmessage = (event: MessageEvent<SignerMessage>) => {
    const message = event.data;
    if (!settle) {
      // Cancelled: the worker has aborted its output (or finished regardless).
      if (message.type === "failed" || message.type === "sealed") {
        stop();
      }
      return;
    }
    switch (message.type) {
      case "seal-progress":
        onProgress?.(message.read, message.total);
        break;
      case "sealed":
        finish({
          sealed: {
            seal: message.seal,
            packageId: message.packageId,
            size: message.size,
            calendars: message.calendars,
            ...(message.blob && { blob: message.blob }),
          },
        });
        break;
      case "failed":
        finish({
          error: new SealError(
            message.reason === "changed" || message.reason === "too-large" || message.reason === "calendars" ? message.reason : "other",
            message.message,
          ),
        });
        break;
      default:
        break;
    }
  };
  key.worker.onerror = (event) => {
    event.preventDefault();
    finish({ error: new SealError("other", event.message || "The sealing worker failed") });
  };
  const request: SignerRequest = { type: "seal", files, role, output, timestamp };
  key.worker.postMessage(request);
  return {
    result,
    stopped,
    cancel() {
      if (!settle) {
        return;
      }
      finish({ error: new SealError("cancelled", "Cancelled") }, true);
      const cancel: SignerRequest = { type: "cancel" };
      key.worker.postMessage(cancel);
      setTimeout(stop, CANCEL_GRACE_MS);
    },
  };
}

/** The passphrase rules of `docseal keygen`: at least 8 characters, typed twice alike. */
export function checkNewPassphrase(passphrase: string, repeated: string): "short" | "mismatch" | undefined {
  if (passphrase.length < 8) {
    return "short";
  }
  return passphrase === repeated ? undefined : "mismatch";
}
