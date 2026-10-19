// The page's side of verification: one Web Worker per package, so the page stays responsive.
import type { TrustedKey, VerificationReport } from "@docseal/core";
import type { VerifyMessage, VerifyRequest } from "./protocol";

export class VerificationCancelled extends Error {
  override name = "VerificationCancelled";
  constructor() {
    super("Verification was cancelled");
  }
}

export interface VerificationTask {
  /** The report; rejects with VerificationCancelled after `cancel`, or if the package cannot be read. */
  readonly result: Promise<VerificationReport>;
  /** Stops the work at once. Verification writes nothing, so stopping the worker is safe. */
  cancel(): void;
}

export interface VerifyInWorkerOptions {
  trustedKeys?: readonly TrustedKey[];
  onProgress?: (read: number, total: number) => void;
}

export function verifyInWorker(file: Blob, options: VerifyInWorkerOptions = {}): VerificationTask {
  const worker = new Worker(new URL("./verify.worker.ts", import.meta.url), { type: "module" });
  let settle: { resolve: (report: VerificationReport) => void; reject: (error: Error) => void } | undefined;
  const result = new Promise<VerificationReport>((resolve, reject) => {
    settle = { resolve, reject };
  });
  /** Ends the task once: later messages from a stopped worker are ignored. */
  const finish = (outcome: { report: VerificationReport } | { error: Error }) => {
    if (!settle) {
      return;
    }
    const { resolve, reject } = settle;
    settle = undefined;
    worker.terminate();
    if ("report" in outcome) {
      resolve(outcome.report);
    } else {
      reject(outcome.error);
    }
  };

  worker.onmessage = (event: MessageEvent<VerifyMessage>) => {
    const message = event.data;
    if (!settle) {
      return;
    }
    switch (message.type) {
      case "progress":
        options.onProgress?.(message.read, message.total);
        break;
      case "report":
        finish({ report: message.report });
        break;
      case "failed":
        finish({ error: new Error(message.message) });
        break;
    }
  };
  // The worker script did not load or threw outside the verification (e.g. blocked by the CSP).
  worker.onerror = (event) => {
    event.preventDefault();
    finish({ error: new Error(event.message || "The verification worker failed") });
  };
  worker.onmessageerror = () => {
    finish({ error: new Error("The verification worker sent a message that could not be read") });
  };

  const request: VerifyRequest = { file, ...(options.trustedKeys && { trustedKeys: options.trustedKeys }) };
  worker.postMessage(request);
  return {
    result,
    cancel() {
      finish({ error: new VerificationCancelled() });
    },
  };
}
