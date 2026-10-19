// The page's side of a key: a worker that holds it. The page only ever learns the public key.
import type { SignerMessage, SignerRequest } from "./protocol";

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
        fail(new KeyError(message.reason, message.message));
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

/** The passphrase rules of `docseal keygen`: at least 8 characters, typed twice alike. */
export function checkNewPassphrase(passphrase: string, repeated: string): "short" | "mismatch" | undefined {
  if (passphrase.length < 8) {
    return "short";
  }
  return passphrase === repeated ? undefined : "mismatch";
}
