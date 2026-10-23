import type { AxisVerdicts, VerificationReport } from "@docseal/core";
import { sanitize } from "@docseal/node";

const HEADLINES: Record<VerificationReport["overall"], string> = {
  valid: "VALID: every check passed",
  invalid: "INVALID: the package was modified or a proof is false",
  indeterminate: "INDETERMINATE: nothing is wrong, but not everything could be confirmed",
};

const AXES: (keyof AxisVerdicts)[] = ["format", "integrity", "signature", "trust", "time", "completeness"];

/** Human-readable report. Carries the same facts as the JSON report, never more. Safe for terminals. */
export function formatReport(report: VerificationReport): string {
  const lines = [HEADLINES[report.overall], ""];
  for (const axis of AXES) {
    const detail = axisDetail(axis, report);
    lines.push(`  ${axis.padEnd(13)} ${report.axes[axis].padEnd(13)}${detail ? ` ${detail}` : ""}`.trimEnd());
  }

  const problems = report.files.filter((file) => file.status !== "valid");
  if (problems.length > 0) {
    lines.push("", "Files:");
    for (const file of problems) {
      lines.push(`  ${file.status.padEnd(9)} ${file.path}`);
    }
  }

  // A pending proof is a state, not a problem; it is already shown on the time line.
  const issues = report.issues.filter((issue) => issue.code !== "pending");
  if (issues.length > 0) {
    lines.push("", "Issues:");
    for (const issue of issues) {
      lines.push(`  [${issue.axis}] ${issue.subject ? `${issue.subject}: ` : ""}${issue.message}`);
    }
  }

  const hints = hintsFor(report);
  if (hints.length > 0) {
    lines.push("", "Next steps:", ...hints.map((hint) => `  - ${hint}`));
  }

  lines.push(
    "",
    "DocSeal proves that the files are unchanged, that they were signed by the key shown, and that",
    "the signed state existed no later than the confirmed time. It does not prove who owns the key.",
  );
  // Every line may contain text from the package; none of ours contains a newline.
  return `${lines.map(sanitize).join("\n")}\n`;
}

function axisDetail(axis: keyof AxisVerdicts, report: VerificationReport): string {
  switch (axis) {
    case "integrity": {
      if (report.files.length === 0) return "";
      const ok = report.files.filter((file) => file.status === "valid").length;
      return `${String(ok)} of ${String(report.files.length)} files match`;
    }
    case "signature":
      return report.signatures
        .map((s) => `${s.signer ? shorten(s.signer) : s.entry}${s.role ? ` (${s.role})` : ""}`)
        .join(", ");
    case "trust":
      return [...new Set(report.signatures.flatMap((s) => (s.trustReason === undefined ? [] : [s.trustReason])))].join("; ");
    case "time": {
      if (report.attestedAt) {
        const anchor = report.anchors.find((a) => a.verdict === "confirmed");
        const via = anchor?.source ? ` via ${anchor.source}` : "";
        const block = anchor?.blockHeight === undefined ? "" : ` block ${String(anchor.blockHeight)}`;
        const confirmations = anchor?.confirmations === undefined ? "" : `, ${String(anchor.confirmations)} confirmations`;
        return `no later than ${report.attestedAt.replace("T", " ").replace(/\.000Z$|Z$/, " UTC")} (Bitcoin${block}${confirmations}${via})`;
      }
      // A proof already in a block says how far along it is.
      return report.anchors
        .flatMap((a) =>
          a.reason
            ? [a.blockHeight === undefined ? a.reason : `${a.reason} (block ${String(a.blockHeight)}, ${String(a.confirmations ?? 0)} so far)`]
            : [],
        )
        .join("; ");
    }
    default:
      return "";
  }
}

function hintsFor(report: VerificationReport): string[] {
  const hints: string[] = [];
  if (report.axes.trust === "not-evaluated" && report.axes.signature === "valid") {
    hints.push("Trust was not evaluated: pass --trust <trusted-keys.json> with the keys you accept.");
  }
  if (report.axes.time === "pending") {
    hints.push("The time proof is pending: run `docseal upgrade <package>` in a few hours.");
  }
  if (report.axes.time === "missing") {
    hints.push("The package has no time proof: it was sealed with --no-anchor.");
  }
  if (report.axes.time === "unsupported") {
    hints.push("The time proof could not be checked here: check network access, or name another source with --chain.");
  }
  return hints;
}

/** did:key:z6MkABCDEFGH…WXYZ — enough to compare by eye, short enough for a terminal. */
function shorten(id: string): string {
  return id.length > 32 ? `${id.slice(0, 20)}…${id.slice(-6)}` : id;
}
