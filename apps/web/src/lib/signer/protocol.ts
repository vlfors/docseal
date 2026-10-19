// Messages between the page and the signer worker. The secret key exists only inside the
// worker: the page sends a key file and its passphrase (or a passphrase for a new key) and
// gets back the public key, and for a new key the encrypted key file to save.

export type SignerRequest =
  | { type: "open"; keyFile: Uint8Array; passphrase: string }
  | { type: "generate"; passphrase: string };

export type SignerMessage =
  /** scrypt's share done, from 0 to 1. */
  | { type: "key-progress"; share: number }
  /** The key is open in the worker. `keyFile` is set for a new key: the encrypted file to save. */
  | { type: "ready"; did: string; keyFile?: Uint8Array }
  /** `passphrase`: wrong passphrase (or a damaged file); `file`: not a usable key file. */
  | { type: "failed"; reason: "passphrase" | "file" | "other"; message: string };
