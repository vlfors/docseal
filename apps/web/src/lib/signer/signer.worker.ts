// Holds one secret key, off the page: the page starts a new worker for each key it opens and
// terminates it when the key is closed or a sealing ends, which erases the key.
import type { SignerMessage, SignerRequest } from "./protocol";
import { Signer } from "./run";

// The worker's global scope, typed without the WebWorker library, which conflicts with the DOM one.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SignerRequest>) => void) | null;
  postMessage(message: SignerMessage): void;
};

const signer = new Signer((message) => {
  scope.postMessage(message);
});

scope.onmessage = (event) => {
  void signer.handle(event.data);
};
