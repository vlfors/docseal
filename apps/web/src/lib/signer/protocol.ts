// Messages between the page and the signer worker. The secret key exists only inside the
// worker: the page sends a key file and its passphrase (or a passphrase for a new key) and
// gets back the public key, and for a new key the encrypted key file to save. Then it sends
// the documents once, and gets back the sealed package or the file it was written to.
import type { SealRequestFile } from "../seal/seal";

/**
 * Where the package goes: a file picked with showSaveFilePicker, written as it is produced, or
 * memory, handed back as one Blob of at most `limit` bytes.
 */
export type SealOutput = { kind: "file"; handle: FileSystemFileHandle } | { kind: "memory"; limit: number };

export type SignerRequest =
  | { type: "open"; keyFile: Uint8Array; passphrase: string }
  | { type: "generate"; passphrase: string }
  | { type: "seal"; files: SealRequestFile[]; role: string; output: SealOutput }
  /** Stops a sealing: the output is aborted (a picked file is released) before the reply. */
  | { type: "cancel" };

export type SignerMessage =
  /** scrypt's share done, from 0 to 1. */
  | { type: "key-progress"; share: number }
  /** The key is open in the worker. `keyFile` is set for a new key: the encrypted file to save. */
  | { type: "ready"; did: string; keyFile?: Uint8Array }
  /** Bytes of the documents read while sealing (each is read twice), and the total. */
  | { type: "seal-progress"; read: number; total: number }
  /** The package is complete: in the picked file, or as `blob`. The key is already erased. */
  | { type: "sealed"; seal: string; packageId: string; size: number; blob?: Blob }
  /**
   * `passphrase`: wrong passphrase (or a damaged file); `file`: not a usable key file;
   * `changed`: a document changed or vanished while it was being sealed; `too-large`: over the
   * memory limit; `cancelled`: stopped on request, the output already aborted.
   */
  | { type: "failed"; reason: "passphrase" | "file" | "changed" | "too-large" | "cancelled" | "other"; message: string };
