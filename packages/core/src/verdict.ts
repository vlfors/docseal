/** Verification axes from FORMAT-v0.1 §Verdicts. */

export type FormatVerdict = "valid" | "invalid" | "unsupported";
export type IntegrityVerdict = "valid" | "invalid" | "not-checked";
export type SignatureVerdict = "valid" | "invalid" | "unsupported" | "missing";
export type TrustVerdict = "trusted" | "untrusted" | "unknown" | "not-evaluated";
export type TimeVerdict = "confirmed" | "pending" | "invalid" | "unsupported" | "missing";
export type CompletenessVerdict = "full" | "partial" | "incomplete";
export type OverallVerdict = "valid" | "invalid" | "indeterminate";

export interface AxisVerdicts {
  format: FormatVerdict;
  integrity: IntegrityVerdict;
  signature: SignatureVerdict;
  trust: TrustVerdict;
  time: TimeVerdict;
  completeness: CompletenessVerdict;
}

/** Combines the axes into the overall verdict. `valid` requires every axis to be at its strongest value. */
export function overallVerdict(axes: AxisVerdicts): OverallVerdict {
  if (
    axes.format === "invalid" ||
    axes.integrity === "invalid" ||
    axes.signature === "invalid" ||
    axes.time === "invalid"
  ) {
    return "invalid";
  }
  if (
    axes.format === "valid" &&
    axes.integrity === "valid" &&
    axes.signature === "valid" &&
    axes.trust === "trusted" &&
    axes.time === "confirmed" &&
    axes.completeness === "full"
  ) {
    return "valid";
  }
  return "indeterminate";
}
