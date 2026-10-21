/**
 * What the page shows of a verification report: the same facts as the CLI's text report
 * (apps/cli/src/report.ts), never more, arranged for the page. Strings from the package stay
 * separate values so the page can show them as text with unsafe characters made visible; the
 * words around them come from the dictionaries.
 */
import type { AnchorReport, AxisVerdicts, FileResult, Issue, OverallVerdict, SignatureResult, VerificationReport } from "@docseal/core";

export type Axis = keyof AxisVerdicts;
export const AXES: readonly Axis[] = ["format", "integrity", "signature", "trust", "time", "completeness"];

/** good: the strongest value; bad: a value that makes the package invalid or untrusted. */
export type Tone = "good" | "bad" | "neutral";

export type AxisDetail =
  | { kind: "none" }
  | { kind: "files"; ok: number; total: number }
  | { kind: "signers"; signers: { id: string; role?: string }[] }
  | { kind: "reasons"; reasons: string[] }
  | { kind: "attested"; at: string; confirmations?: number; blockHeight?: number; source?: string };

export interface AxisRow {
  axis: Axis;
  verdict: string;
  tone: Tone;
  detail: AxisDetail;
}

export type Hint = "trustNotEvaluated" | "timePending" | "timeMissing" | "timeUnsupported" | "timeOffline";

export interface ReportView {
  overall: OverallVerdict;
  /**
   * An indeterminate package whose documents are unchanged and whose signatures verify: what is
   * proven is shown apart from what is not (`unconfirmed`), rather than as one doubtful verdict.
   */
  authentic: boolean;
  /** For an authentic package, the axes short of their strongest value. */
  unconfirmed: ("trust" | "time" | "completeness")[];
  axes: AxisRow[];
  /** Files that are not unchanged, in the report's order. */
  problemFiles: FileResult[];
  files: FileResult[];
  signatures: SignatureResult[];
  anchors: AnchorReport[];
  /** Issues except pending proofs, which are a state shown on the time row, not a problem. */
  issues: Issue[];
  /** Whether any time proof is pending, so an upgrade may complete it. */
  pending: boolean;
  hints: Hint[];
  technical: { packageId?: string; seal?: string; merkleRoot?: string; statementHash?: string };
}

const STRONGEST: Record<Axis, string> = {
  format: "valid",
  integrity: "valid",
  signature: "valid",
  trust: "trusted",
  time: "confirmed",
  completeness: "full",
};

function tone(axis: Axis, verdict: string): Tone {
  if (verdict === STRONGEST[axis]) {
    return "good";
  }
  return verdict === "invalid" || verdict === "untrusted" ? "bad" : "neutral";
}

function detail(axis: Axis, report: VerificationReport): AxisDetail {
  switch (axis) {
    case "integrity":
      return report.files.length === 0
        ? { kind: "none" }
        : { kind: "files", ok: report.files.filter((file) => file.status === "valid").length, total: report.files.length };
    case "signature":
      return report.signatures.length === 0
        ? { kind: "none" }
        : { kind: "signers", signers: report.signatures.map((s) => ({ id: s.signer ?? s.entry, ...(s.role !== undefined && { role: s.role }) })) };
    case "trust": {
      const reasons = [...new Set(report.signatures.flatMap((s) => (s.trustReason === undefined ? [] : [s.trustReason])))];
      return reasons.length === 0 ? { kind: "none" } : { kind: "reasons", reasons };
    }
    case "time": {
      if (report.attestedAt) {
        const anchor = report.anchors.find((a) => a.verdict === "confirmed");
        return {
          kind: "attested",
          at: report.attestedAt,
          ...(anchor?.confirmations !== undefined && { confirmations: anchor.confirmations }),
          ...(anchor?.blockHeight !== undefined && { blockHeight: anchor.blockHeight }),
          ...(anchor?.source !== undefined && { source: anchor.source }),
        };
      }
      const reasons = report.anchors.flatMap((a) => (a.reason ? [a.reason] : []));
      return reasons.length === 0 ? { kind: "none" } : { kind: "reasons", reasons };
    }
    default:
      return { kind: "none" };
  }
}

function hints(report: VerificationReport, online: boolean): Hint[] {
  const out: Hint[] = [];
  if (report.axes.trust === "not-evaluated" && report.axes.signature === "valid") {
    out.push("trustNotEvaluated");
  }
  if (report.axes.time === "pending") {
    out.push("timePending");
  }
  if (report.axes.time === "missing" && report.axes.format === "valid") {
    out.push("timeMissing");
  }
  if (report.axes.time === "unsupported") {
    out.push(online ? "timeUnsupported" : "timeOffline");
  }
  return out;
}

/** `online`: whether a chain source was configured, which changes the advice on time. */
export function viewReport(report: VerificationReport, options: { online?: boolean } = {}): ReportView {
  const { axes } = report;
  const authentic =
    report.overall === "indeterminate" &&
    axes.format === "valid" &&
    axes.integrity === "valid" &&
    axes.signature === "valid" &&
    axes.trust !== "untrusted";
  return {
    overall: report.overall,
    authentic,
    unconfirmed: authentic ? (["trust", "time", "completeness"] as const).filter((axis) => axes[axis] !== STRONGEST[axis]) : [],
    axes: AXES.map((axis) => ({ axis, verdict: report.axes[axis], tone: tone(axis, report.axes[axis]), detail: detail(axis, report) })),
    problemFiles: report.files.filter((file) => file.status !== "valid"),
    files: report.files,
    signatures: report.signatures,
    anchors: report.anchors,
    issues: report.issues.filter((issue) => issue.code !== "pending"),
    pending: report.anchors.some((anchor) => anchor.verdict === "pending"),
    hints: hints(report, options.online ?? false),
    technical: {
      ...(report.packageId !== undefined && { packageId: report.packageId }),
      ...(report.seal !== undefined && { seal: report.seal }),
      ...(report.merkleRoot !== undefined && { merkleRoot: report.merkleRoot }),
      ...(report.statementHash !== undefined && { statementHash: report.statementHash }),
    },
  };
}
