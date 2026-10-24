import type { VerificationReport } from "@docseal/core";
import type { VerifyOutput } from "./schemas.js";
import { capList, fenceAll } from "./untrusted.js";

/**
 * What the verify tool says about a report. Every sentence here is DocSeal's own: text from the
 * package stays in the report's fields and never reaches the summary, the steps, or the list
 * of what is not confirmed.
 */

export const DISCLAIMER =
  "DocSeal proves that the files are unchanged, that they were signed by the key shown, and that the signed state " +
  "existed no later than the confirmed time. It does not prove who owns the key, that the contents are true, or that " +
  "the signature has legal force.";

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export interface VerifyContext {
  /** Whether the server has a trusted-keys file. */
  trustConfigured: boolean;
  /** Whether the server may read Bitcoin block headers. */
  online: boolean;
}

export function describeReport(report: VerificationReport, context: VerifyContext): VerifyOutput {
  const notConfirmed = unconfirmed(report);
  const { report: shown, omitted } = shorten(report);
  return {
    verdict: report.overall,
    summary: summary(report, notConfirmed) + (omitted ? " Some lists in the report are shortened: see omitted." : ""),
    notConfirmed,
    nextSteps: nextSteps(report, context),
    report: fenceAll(shown),
    ...(omitted && { omitted }),
    disclaimer: DISCLAIMER,
  };
}

/** The report with each list capped; files and issues that matter most are kept first. */
function shorten(report: VerificationReport): { report: VerificationReport; omitted?: NonNullable<VerifyOutput["omitted"]> } {
  const files = capList(report.files, (file) => file.status !== "valid");
  const signatures = capList(report.signatures, (signature) => signature.check !== "valid");
  const anchors = capList(report.anchors);
  const issues = capList(report.issues);
  const counts = { files: files.omitted, signatures: signatures.omitted, anchors: anchors.omitted, issues: issues.omitted };
  const shown = { ...report, files: files.kept, signatures: signatures.kept, anchors: anchors.kept, issues: issues.kept };
  return Object.values(counts).some((n) => n > 0) ? { report: shown, omitted: counts } : { report: shown };
}

function unconfirmed(report: VerificationReport): string[] {
  if (report.overall !== "indeterminate") {
    return [];
  }
  const { axes } = report;
  const out: string[] = [];
  if (axes.format === "unsupported") out.push("the package: it uses a format feature this server does not support");
  if (axes.integrity === "not-checked") out.push("that the files are unchanged");
  if (axes.signature === "unsupported") out.push("the signature: it uses a kind this server cannot check");
  if (axes.signature === "missing") out.push("who signed the package: it has no signature this server could check");
  if (axes.trust === "untrusted") out.push("the signer: the signing key is marked as not trusted");
  if (axes.trust === "unknown" || axes.trust === "not-evaluated") out.push("who owns the signing key");
  if (axes.time !== "confirmed") out.push("when the files existed");
  if (axes.completeness !== "full") out.push("that every signature and proof in the package was checked");
  return out;
}

function summary(report: VerificationReport, notConfirmed: readonly string[]): string {
  const { axes } = report;
  switch (report.overall) {
    case "valid": {
      const at = report.attestedAt !== undefined && RFC3339.test(report.attestedAt) ? ` no later than ${report.attestedAt}` : "";
      return `VALID: the files are unchanged, they were signed by a trusted key, and they existed${at} (confirmed by Bitcoin).`;
    }
    case "invalid": {
      const reasons: string[] = [];
      if (axes.format === "invalid") reasons.push("the package is malformed");
      if (axes.integrity === "invalid") {
        const changed = report.files.filter((file) => file.status !== "valid").length;
        reasons.push(`${String(changed)} of ${String(report.files.length)} files are modified, missing, or extra`);
      }
      if (axes.signature === "invalid") reasons.push("a signature does not verify");
      if (axes.time === "invalid") reasons.push("the time proof is false");
      return `INVALID: do not rely on this package. ${capitalize(reasons.join("; "))}.`;
    }
    case "indeterminate": {
      const authentic = axes.format === "valid" && axes.integrity === "valid" && axes.signature === "valid";
      const proven = authentic ? " Confirmed: the files are unchanged and the signature verifies." : "";
      return `INDETERMINATE. Not confirmed: ${notConfirmed.join("; ")}.${proven} Do not call this package valid or authentic.`;
    }
  }
}

function nextSteps(report: VerificationReport, context: VerifyContext): string[] {
  const { axes } = report;
  const steps: string[] = [];
  if (report.overall === "invalid") {
    steps.push("Tell the person the package is invalid, and ask the sender for a fresh copy if one is needed.");
  }
  if (axes.signature === "valid" && axes.trust === "not-evaluated" && !context.trustConfigured) {
    steps.push(
      "Trust was not evaluated: the server has no trusted keys. Only the person running it can add them " +
        "(a trusted-keys.json given with --trust), after confirming the signer's key with the signer through another channel.",
    );
  }
  if (axes.trust === "unknown") {
    steps.push(
      "The signing key is not among the trusted keys. Ask the person to confirm the key with the signer through " +
        "another channel; only they can add it to the trusted keys.",
    );
  }
  if (axes.time === "pending") steps.push("The time proof is not complete yet: call upgrade on the package in a few hours.");
  if (axes.time === "missing" && axes.format === "valid") {
    steps.push("The package has no time proof: it was sealed without one, and one cannot be added later.");
  }
  if (axes.time === "unsupported") {
    steps.push(
      context.online
        ? "The time proof could not be checked: the Bitcoin source did not answer. Try again later."
        : "The time proof was not checked: the server runs offline.",
    );
  }
  return steps;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
