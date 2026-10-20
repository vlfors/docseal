// The page's side of verification: one Web Worker per package, so the page stays responsive.
import type { TrustedKey, VerificationReport } from "@docseal/core";
import type { PackageOutput } from "../output";
import type { ChainSetting, ProofProgress, VerifyMessage, VerifyRequest } from "./protocol";

export class VerificationCancelled extends Error {
  override name = "VerificationCancelled";
  constructor() {
    super("Verification was cancelled");
  }
}

export interface Task<T> {
  /** Rejects with VerificationCancelled after `cancel`, or if the package cannot be read. */
  readonly result: Promise<T>;
  /**
   * Stops the work at once. Verifying and checking for upgrades write nothing; an upgrade being
   * saved to a picked file leaves it unfinished, and the caller removes it.
   */
  cancel(): void;
}

/** A verification in progress. */
export type VerificationTask = Task<VerificationReport>;

export interface Upgraded {
  /** Whether a calendar had completed a proof. */
  changed: boolean;
  size?: number;
  /** The upgraded package, for memory output. */
  blob?: Blob;
  /** How far the time proofs have come, when the seal and a chain were given. */
  progress?: ProofProgress;
}

/** Runs `request` in a new worker, which is terminated when the result is in. */
function start<T>(request: VerifyRequest, pick: (message: VerifyMessage) => T | undefined, onProgress?: (read: number, total: number) => void): Task<T> {
  const worker = new Worker(new URL("./verify.worker.ts", import.meta.url), { type: "module" });
  let settle: { resolve: (value: T) => void; reject: (error: Error) => void } | undefined;
  const result = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  /** Ends the task once: later messages from a stopped worker are ignored. */
  const finish = (outcome: { value: T } | { error: Error }) => {
    if (!settle) {
      return;
    }
    const { resolve, reject } = settle;
    settle = undefined;
    worker.terminate();
    if ("value" in outcome) {
      resolve(outcome.value);
    } else {
      reject(outcome.error);
    }
  };

  worker.onmessage = (event: MessageEvent<VerifyMessage>) => {
    const message = event.data;
    if (message.type === "progress") {
      onProgress?.(message.read, message.total);
    } else if (message.type === "failed") {
      finish({ error: new Error(message.message) });
    } else {
      const value = pick(message);
      if (value !== undefined) {
        finish({ value });
      }
    }
  };
  // The worker script did not load or threw outside the work (e.g. blocked by the CSP).
  worker.onerror = (event) => {
    event.preventDefault();
    finish({ error: new Error(event.message || "The verification worker failed") });
  };
  worker.onmessageerror = () => {
    finish({ error: new Error("The verification worker sent a message that could not be read") });
  };
  worker.postMessage(request);
  return {
    result,
    cancel() {
      finish({ error: new VerificationCancelled() });
    },
  };
}

export interface VerifyInWorkerOptions {
  trustedKeys?: readonly TrustedKey[];
  /** Offline unless given. */
  chain?: ChainSetting;
  onProgress?: (read: number, total: number) => void;
}

export function verifyInWorker(file: Blob, options: VerifyInWorkerOptions = {}): Task<VerificationReport> {
  const request: VerifyRequest = {
    type: "verify",
    file,
    chain: options.chain ?? { kind: "offline" },
    ...(options.trustedKeys && { trustedKeys: options.trustedKeys }),
  };
  return start(request, (message) => (message.type === "report" ? message.report : undefined), options.onProgress);
}

export interface UpgradeInWorkerOptions {
  /** Where to write the upgraded package; without it, only whether a proof changed is told. */
  output?: PackageOutput;
  /** The seal as verification recomputed it, and the chain to check the proofs against. */
  seal?: string;
  chain?: ChainSetting;
  onProgress?: (read: number, total: number) => void;
}

/** Asks the calendars for completed proofs; with `output`, writes the upgraded package there. */
export function upgradeInWorker(file: Blob, options: UpgradeInWorkerOptions = {}): Task<Upgraded> {
  const { output, seal, chain } = options;
  const request: VerifyRequest = { type: "upgrade", file, ...(output && { output }), ...(seal !== undefined && { seal }), ...(chain && { chain }) };
  return start(
    request,
    (message) =>
      message.type === "upgraded"
        ? {
            changed: message.changed,
            ...(message.size !== undefined && { size: message.size }),
            ...(message.blob && { blob: message.blob }),
            ...(message.progress && { progress: message.progress }),
          }
        : undefined,
    options.onProgress,
  );
}
