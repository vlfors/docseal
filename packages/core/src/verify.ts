import { hash } from "./bytes.js";
import { DEFAULT_LIMITS, readContainer, type ContainerLimits, type PackageContents } from "./container.js";
import { jsonHash, signaturesSetHash, signedBytes } from "./digests.js";
import { EncodingError, fromBase64url, toHex } from "./encoding.js";
import { FormatError } from "./errors.js";
import { parseJson } from "./json.js";
import { leafHash, merkleRoot } from "./merkle.js";
import { parseEnvelope, parseManifest, parseStatement, type Manifest, type Statement } from "./model.js";
import type { SignatureCheck, SignatureSuite, TrustPolicy, TrustResult } from "./plugins.js";
import { overallVerdict, type AxisVerdicts, type OverallVerdict } from "./verdict.js";

export interface VerifyOptions {
  /** Signature suites the application trusts to run. Nothing is ever loaded from the package. */
  suites: readonly SignatureSuite[];
  /** Without a policy, `trust` is `not-evaluated` and the overall verdict cannot be `valid`. */
  trust?: TrustPolicy;
  limits?: Partial<ContainerLimits>;
}

export interface Issue {
  axis: keyof AxisVerdicts;
  code: string;
  message: string;
  /** File path or container entry the issue refers to. */
  subject?: string;
}

export interface FileResult {
  path: string;
  status: "valid" | "modified" | "missing" | "extra";
}

export interface SignatureResult {
  entry: string;
  check: SignatureCheck;
  signer?: string;
  suite?: string;
  profile?: string;
  role?: string;
  /** Signer's own clock; not evidence of time. */
  claimedAt?: string;
  trust?: TrustResult["verdict"];
}

export interface VerificationReport {
  overall: OverallVerdict;
  axes: AxisVerdicts;
  packageId?: string;
  merkleRoot?: string;
  statementHash?: string;
  files: FileResult[];
  signatures: SignatureResult[];
  issues: Issue[];
}

export async function verifyPackage(zip: Uint8Array, options: VerifyOptions): Promise<VerificationReport> {
  const report: Omit<VerificationReport, "overall"> = {
    axes: {
      format: "valid",
      integrity: "not-checked",
      signature: "missing",
      trust: "not-evaluated",
      time: "missing",
      completeness: "incomplete",
    },
    files: [],
    signatures: [],
    issues: [],
  };
  const finish = (): VerificationReport => ({ overall: overallVerdict(report.axes), ...report });

  let contents: PackageContents;
  let manifest: Manifest;
  let statement: Statement;
  try {
    contents = readContainer(zip, { ...DEFAULT_LIMITS, ...options.limits });
    manifest = parseManifest(parseJson(contents.manifest));
    statement = parseStatement(parseJson(contents.statement));
  } catch (error) {
    if (!(error instanceof FormatError)) {
      throw error;
    }
    report.axes.format = error.verdict;
    report.issues.push({ axis: "format", code: error.code, message: error.message });
    return finish();
  }
  const statementHash = jsonHash(statement);
  report.packageId = statement.packageId;
  report.merkleRoot = statement.merkleRoot;
  report.statementHash = toHex(statementHash);

  const filesComplete = checkIntegrity(contents, manifest, statement, report);
  const signaturesComplete = await checkSignatures(contents, statementHash, options, report);

  if (contents.anchors.size > 0) {
    report.axes.time = "unsupported";
    report.issues.push({ axis: "time", code: "not-implemented", message: "Anchor verification is not implemented yet" });
  }

  report.axes.completeness =
    filesComplete && signaturesComplete && report.axes.time !== "unsupported" ? "full" : "incomplete";
  return finish();
}

/** Returns whether every manifest file was available to hash. */
function checkIntegrity(
  contents: PackageContents,
  manifest: Manifest,
  statement: Statement,
  report: Omit<VerificationReport, "overall">,
): boolean {
  const issuesBefore = report.issues.length;
  let complete = true;
  const fail = (code: string, message: string, subject?: string) => {
    report.issues.push({ axis: "integrity", code, message, ...(subject === undefined ? {} : { subject }) });
  };

  if (toHex(jsonHash(manifest)) !== statement.manifestHash) {
    fail("manifest-hash", "manifest.json does not match statement.manifestHash");
  }
  if (manifest.packageId !== statement.packageId) {
    fail("package-id", "manifest and statement have different packageId");
  }
  if (toHex(merkleRoot(manifest.files.map(leafHash))) !== statement.merkleRoot) {
    fail("merkle-root", "Merkle root of the manifest does not match statement.merkleRoot");
  }

  const listed = new Set<string>();
  for (const entry of manifest.files) {
    listed.add(entry.path);
    const data = contents.files.get(entry.path);
    if (data === undefined) {
      complete = false;
      report.files.push({ path: entry.path, status: "missing" });
      fail("missing-file", "File listed in the manifest is missing", entry.path);
    } else if (data.length !== entry.size || toHex(hash(data)) !== entry.hash) {
      report.files.push({ path: entry.path, status: "modified" });
      fail("modified-file", "File contents do not match the manifest", entry.path);
    } else {
      report.files.push({ path: entry.path, status: "valid" });
    }
  }
  for (const path of contents.files.keys()) {
    if (!listed.has(path)) {
      report.files.push({ path, status: "extra" });
      fail("extra-file", "File is not listed in the manifest", path);
    }
  }

  report.axes.integrity = report.issues.length === issuesBefore ? "valid" : "invalid";
  return complete;
}

/** Returns whether every signature could be evaluated. */
async function checkSignatures(
  contents: PackageContents,
  statementHash: Uint8Array,
  options: VerifyOptions,
  report: Omit<VerificationReport, "overall">,
): Promise<boolean> {
  const fail = (code: string, message: string, subject: string) => {
    report.issues.push({ axis: "signature", code, message, subject });
  };
  const digests: Uint8Array[] = [];
  const validSigners: SignatureResult[] = [];

  for (const [entry, bytes] of contents.signatures) {
    let envelope;
    try {
      envelope = parseEnvelope(parseJson(bytes));
    } catch (error) {
      if (!(error instanceof FormatError)) {
        throw error;
      }
      report.signatures.push({ entry, check: error.verdict });
      fail(error.code, error.message, entry);
      continue;
    }
    digests.push(jsonHash(envelope));
    const header = envelope.protected;
    const result: SignatureResult = {
      entry,
      check: "invalid",
      signer: header.signer,
      suite: header.suite,
      profile: header.profile,
      ...(header.role === undefined ? {} : { role: header.role }),
      claimedAt: header.claimedAt,
    };
    report.signatures.push(result);

    const suite = options.suites.find((s) => s.id === header.suite && s.profiles.includes(header.profile));
    if (header.critical.length > 0) {
      result.check = "unsupported";
      fail("critical", `Unknown critical extensions: ${header.critical.join(", ")}`, entry);
    } else if (!suite) {
      result.check = "unsupported";
      fail("unsupported-suite", `No registered suite for ${header.suite}/${header.profile}`, entry);
    } else if (header.statementHash !== toHex(statementHash)) {
      fail("statement-hash", "Signature is for a different statement", entry);
    } else {
      let value: Uint8Array;
      try {
        value = fromBase64url(envelope.value);
      } catch (error) {
        if (!(error instanceof EncodingError)) {
          throw error;
        }
        fail("encoding", "Signature value is not valid base64url", entry);
        continue;
      }
      result.check = await suite.verify(header.signer, signedBytes(header), value, header.profile);
      if (result.check === "invalid") {
        fail("bad-signature", "Signature does not verify", entry);
      } else if (result.check === "valid") {
        validSigners.push(result);
      }
    }
  }

  try {
    signaturesSetHash(digests);
  } catch (error) {
    if (!(error instanceof FormatError)) {
      throw error;
    }
    fail(error.code, error.message, "signatures/");
    report.axes.signature = "invalid";
  }

  const checks = report.signatures.map((s) => s.check);
  if (report.axes.signature !== "invalid") {
    report.axes.signature = checks.includes("invalid")
      ? "invalid"
      : validSigners.length > 0
        ? "valid"
        : checks.includes("unsupported")
          ? "unsupported"
          : "missing";
  }
  if (report.axes.signature === "missing") {
    fail("no-signatures", "The package has no signatures", "signatures/");
  }

  if (options.trust && report.axes.signature === "valid") {
    const verdicts: TrustResult["verdict"][] = [];
    for (const result of validSigners) {
      const outcome = await options.trust.evaluate(result.signer ?? "", { attestedAt: null });
      result.trust = outcome.verdict;
      verdicts.push(outcome.verdict);
      if (outcome.verdict !== "trusted") {
        report.issues.push({
          axis: "trust",
          code: outcome.verdict,
          message: outcome.reason ?? `Signer is ${outcome.verdict} under policy ${options.trust.id}`,
          subject: result.entry,
        });
      }
    }
    report.axes.trust = verdicts.includes("trusted")
      ? "trusted"
      : verdicts.every((v) => v === "untrusted")
        ? "untrusted"
        : "unknown";
  }

  return !checks.includes("unsupported");
}
