/**
 * Where a pending time proof stands, for the tracker on the Verify page: sent to the calendars,
 * written into a block, or confirmed. Facts come from the report, or from a check of the
 * upgraded proofs against the chain; both find a block only once the proof is in it.
 */
import type { AnchorReport } from "@docseal/core";
import type { ProofProgress } from "../verify/protocol";

export type ProofStage = "submitted" | "in-block" | "confirmed";

/** Bitcoin adds a block about this often, on average. */
export const MINUTES_PER_BLOCK = 10;

/** What the report already tells: the furthest of its pending or confirmed proofs. */
export function progressOf(anchors: readonly AnchorReport[]): ProofProgress {
  const confirmed = anchors.find((anchor) => anchor.verdict === "confirmed");
  if (confirmed) {
    return {
      confirmed: true,
      ...(confirmed.blockHeight !== undefined && { blockHeight: confirmed.blockHeight }),
      ...(confirmed.confirmations !== undefined && { confirmations: confirmed.confirmations }),
    };
  }
  const deepest = anchors
    .filter((anchor) => anchor.verdict === "pending" && anchor.blockHeight !== undefined)
    .sort((a, b) => (b.confirmations ?? 0) - (a.confirmations ?? 0))[0];
  return deepest?.blockHeight === undefined
    ? { confirmed: false }
    : { confirmed: false, blockHeight: deepest.blockHeight, ...(deepest.confirmations !== undefined && { confirmations: deepest.confirmations }) };
}

export function stageOf(progress: ProofProgress): ProofStage {
  return progress.confirmed ? "confirmed" : progress.blockHeight === undefined ? "submitted" : "in-block";
}

/** About how many minutes until `required` confirmations, for a proof already in a block. */
export function minutesLeft(progress: ProofProgress, required: number): number | undefined {
  if (progress.confirmed || progress.confirmations === undefined) {
    return undefined;
  }
  return Math.max(0, required - progress.confirmations) * MINUTES_PER_BLOCK;
}

/** The earliest submission time a receipt records (the sealer's claim), if any is readable. */
export function submittedAt(anchors: readonly AnchorReport[]): Date | undefined {
  const times = anchors.flatMap((anchor) => {
    const time = anchor.submittedAt === undefined ? NaN : Date.parse(anchor.submittedAt);
    return Number.isNaN(time) ? [] : [time];
  });
  return times.length === 0 ? undefined : new Date(Math.min(...times));
}
