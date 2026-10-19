// Runs one verification off the page's thread; the page starts a new worker for each package.
import type { VerifyMessage, VerifyRequest } from "./protocol";
import { runVerification } from "./run";

// The worker's global scope, typed without the WebWorker library, which conflicts with the DOM one.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<VerifyRequest>) => void) | null;
  postMessage(message: VerifyMessage): void;
};

scope.onmessage = (event) => {
  void runVerification(event.data, (message) => {
    scope.postMessage(message);
  });
};
