// Messages between the page and the signer worker. The secret key exists only inside the
// worker: the page sends a key file and its passphrase (or a passphrase for a new key) and
// gets back the public key, and for a new key the encrypted key file to save. Then it sends
// the documents once, and gets back the sealed package or the file it was written to.
import type { PackageOutput } from "../output";
import type { SealRequestFile, SealStage } from "../seal/seal";

export type SealOutput = PackageOutput;

export type SignerRequest =
  | { type: "open"; keyFile: Uint8Array; passphrase: string }
  | { type: "generate"; passphrase: string }
  /** `timestamp`: submit the seal to the calendars that accept requests from a browser. */
  | { type: "seal"; files: SealRequestFile[]; role: string; output: SealOutput; timestamp: boolean }
  /** Stops a sealing: the output is aborted (a picked file is released) before the reply. */
  | { type: "cancel" };

export type SignerMessage =
  /** scrypt's share done, from 0 to 1. */
  | { type: "key-progress"; share: number }
  /** The key is open in the worker. `keyFile` is set for a new key: the encrypted file to save. */
  | { type: "ready"; did: string; keyFile?: Uint8Array }
  /** Bytes of the documents read while sealing (each is read twice), and the total. */
  | { type: "seal-progress"; read: number; total: number }
  /** A step of the sealing begins. */
  | { type: "seal-stage"; stage: SealStage }
  /** A calendar answered the seal's submission, or failed to; `message` says why it failed. */
  | { type: "calendar"; origin: string; accepted: boolean; message?: string }
  /** The package is complete: in the picked file, or as `blob`. The key is already erased. */
  /** `calendars`: the origins of the calendars that accepted the seal (none without a time proof). */
  | { type: "sealed"; seal: string; packageId: string; size: number; calendars: string[]; blob?: Blob }
  /**
   * `passphrase`: wrong passphrase (or a damaged file); `file`: not a usable key file;
   * `changed`: a document changed or vanished while it was being sealed; `too-large`: over the
   * memory limit; `calendars`: too few calendars accepted the seal; `cancelled`: stopped on
   * request, the output already aborted.
   */
  | { type: "failed"; reason: "passphrase" | "file" | "changed" | "too-large" | "calendars" | "cancelled" | "other"; message: string };
