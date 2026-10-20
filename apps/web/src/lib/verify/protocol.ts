// Messages between the page and the verification worker. The package goes in; only progress,
// the report, or an upgraded package come back, so documents never reach the page.
import type { TrustedKey, VerificationReport } from "@docseal/core";
import type { PackageOutput } from "../output";

/** Where block headers come from: Esplora instances, tried in turn, or none at all. */
export type ChainSetting = { kind: "offline" } | { kind: "esplora"; urls: readonly string[] };

export type VerifyRequest =
  | {
      type: "verify";
      file: Blob;
      /** Signers to trust. Without a list, trust is not evaluated and the verdict cannot be valid. */
      trustedKeys?: readonly TrustedKey[];
      chain: ChainSetting;
    }
  /**
   * Asks the calendars for completed proofs. Without `output` it only checks whether any proof
   * changed; with it, it also writes the upgraded package there. With `seal` (as verification
   * recomputed it) and a chain source, the proofs are then checked against Bitcoin, to tell how
   * far along they are.
   */
  | { type: "upgrade"; file: Blob; output?: PackageOutput; seal?: string; chain?: ChainSetting };

/** How far the package's time proofs have come, checked against a chain: the furthest one. */
export interface ProofProgress {
  /** Whether a proof has the confirmations required. */
  confirmed: boolean;
  /** The block a proof reached, once one did, and its confirmations so far. */
  blockHeight?: number;
  confirmations?: number;
}

export type VerifyMessage =
  /** Bytes of the package read so far, at most `total`. Approximate: some parts are read twice. */
  | { type: "progress"; read: number; total: number }
  | { type: "report"; report: VerificationReport }
  /** `changed`: a proof was completed. With output, the package is in the file or `blob`. */
  /** `progress`: present when the request named the seal and a chain, and a proof was checked. */
  | { type: "upgraded"; changed: boolean; size?: number; blob?: Blob; progress?: ProofProgress }
  /** The package could not be read at all, e.g. the file was removed. Not a verdict. */
  | { type: "failed"; message: string };
