// Messages between the page and the verification worker. The package goes in; only progress
// and the report come back, so documents never reach the page.
import type { TrustedKey, VerificationReport } from "@docseal/core";

export interface VerifyRequest {
  file: Blob;
  /** Signers to trust. Without a list, trust is not evaluated and the verdict cannot be valid. */
  trustedKeys?: readonly TrustedKey[];
}

export type VerifyMessage =
  /** Bytes of the package read so far, at most `total`. Approximate: some parts are read twice. */
  | { type: "progress"; read: number; total: number }
  | { type: "report"; report: VerificationReport }
  /** The package could not be read at all, e.g. the file was removed. Not a verdict. */
  | { type: "failed"; message: string };
