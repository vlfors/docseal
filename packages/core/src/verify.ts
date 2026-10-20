import { hashStream, type Sha256Factory } from "./bytes.js";
import { DEFAULT_LIMITS, openContainer, type Container, type ContainerLimits } from "./container.js";
import { jsonHash, sealDigest, signaturesSetHash, signedBytes } from "./digests.js";
import { EncodingError, fromBase64url, toHex } from "./encoding.js";
import { FormatError } from "./errors.js";
import { bytesSource, type ByteSource } from "./io.js";
import { parseJson } from "./json.js";
import { leafHash, merkleRoot } from "./merkle.js";
import { parseAnchorFile, parseEnvelope, parseManifest, parseStatement, type Manifest, type Statement } from "./model.js";
import type {
  AnchorProvider,
  AnchorResult,
  ChainReader,
  SignatureCheck,
  SignatureSuite,
  TrustPolicy,
  TrustResult,
} from "./plugins.js";
import { overallVerdict, type AxisVerdicts, type OverallVerdict } from "./verdict.js";

export interface VerifyOptions {
  /** Signature suites the application trusts to run. Nothing is ever loaded from the package. */
  suites: readonly SignatureSuite[];
  /** Without a policy, `trust` is `not-evaluated` and the overall verdict cannot be `valid`. */
  trust?: TrustPolicy;
  /** Anchor providers able to verify receipts. Receipts of other providers are `unsupported`. */
  anchors?: readonly AnchorProvider[];
  /** Source of public-chain data. Without one, confirmed proofs cannot be checked. */
  chain?: ChainReader;
  limits?: Partial<ContainerLimits>;
  /** SHA-256 used for documents; see {@link Sha256Factory}. */
  sha256?: Sha256Factory;
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
  /** Explanation from the trust policy, e.g. the label of a pinned key. */
  trustReason?: string;
}

export interface AnchorReport {
  entry: string;
  provider: string;
  network: string;
  verdict: AnchorResult["verdict"];
  /** Proven time, RFC 3339. */
  attestedAt?: string;
  confirmations?: number;
  /** Height of the block the proof reaches, once it was checked against one. */
  blockHeight?: number;
  /** When the seal was submitted, as recorded in the package by whoever sealed it; not evidence of time. */
  submittedAt?: string;
  /** Data source the proof was checked against. */
  source?: string;
  reason?: string;
}

export interface VerificationReport {
  overall: OverallVerdict;
  axes: AxisVerdicts;
  packageId?: string;
  merkleRoot?: string;
  statementHash?: string;
  /** Seal digest recomputed from the statement and envelopes, lowercase hex. */
  seal?: string;
  /** Earliest confirmed anchor time: the signed state existed no later than this. */
  attestedAt?: string;
  files: FileResult[];
  signatures: SignatureResult[];
  anchors: AnchorReport[];
  issues: Issue[];
}

/** SHA-256 and size of each document, as found in the container. */
type DocumentDigests = Map<string, { digest: string; size: number }>;

/** Verifies a package from memory or, without loading it, from a source such as a file. */
export async function verifyPackage(input: Uint8Array | ByteSource, options: VerifyOptions): Promise<VerificationReport> {
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
    anchors: [],
    issues: [],
  };
  const finish = (): VerificationReport => ({ overall: overallVerdict(report.axes), ...report });

  // Format is invalid if any check of the container or of the two documents fails as invalid,
  // and unsupported only if nothing is invalid: every implementation must reach the same
  // verdict whatever order it checks in.
  const formatFailure = (problems: readonly FormatError[]): VerificationReport => {
    report.axes.format = problems.some((p) => p.verdict === "invalid") ? "invalid" : "unsupported";
    for (const problem of problems) {
      report.issues.push({ axis: "format", code: problem.code, message: problem.message });
    }
    return finish();
  };
  const formatErrors = async <T>(f: () => T | Promise<T>): Promise<{ value: T } | { error: FormatError }> => {
    try {
      return { value: await f() };
    } catch (error) {
      if (error instanceof FormatError) {
        return { error };
      }
      throw error;
    }
  };

  const opened = await formatErrors(() => openContainer(input instanceof Uint8Array ? bytesSource(input) : input, { ...DEFAULT_LIMITS, ...options.limits }));
  if ("error" in opened) {
    return formatFailure([opened.error]);
  }
  const contents = opened.value;
  const parsedManifest = await formatErrors(() => parseManifest(parseJson(contents.manifest)));
  const parsedStatement = await formatErrors(() => parseStatement(parseJson(contents.statement)));
  const problems = [parsedManifest, parsedStatement].flatMap((r) => ("error" in r ? [r.error] : []));
  if (problems.some((p) => p.verdict === "invalid")) {
    return formatFailure(problems);
  }
  // Every document is read to the end, which also checks its size and CRC-32: a damaged
  // container is a format failure, and outranks an unsupported manifest or statement.
  const hashed = await formatErrors(() => hashDocuments(contents, options.sha256));
  if ("error" in hashed) {
    return formatFailure([hashed.error]);
  }
  if ("error" in parsedManifest || "error" in parsedStatement) {
    return formatFailure(problems);
  }
  const manifest = parsedManifest.value;
  const statement = parsedStatement.value;
  const documents = hashed.value;
  const statementHash = jsonHash(statement);
  report.packageId = statement.packageId;
  report.merkleRoot = statement.merkleRoot;
  report.statementHash = toHex(statementHash);

  const filesComplete = checkIntegrity(documents, manifest, statement, report);
  const signatures = await checkSignatures(contents, statementHash, options, report);
  // Time first: trust decisions may depend on the proven time, never on a claimed one.
  const time = await checkAnchors(contents, statementHash, signatures.digests, options, report);
  await checkTrust(signatures.valid, time.attestedAt, options, report);

  report.axes.completeness = filesComplete && signatures.complete && time.complete ? "full" : "incomplete";
  return finish();
}

async function hashDocuments(contents: Container, sha256?: Sha256Factory): Promise<DocumentDigests> {
  const digests: DocumentDigests = new Map();
  for (const [path, entry] of contents.files) {
    const { digest, size } = await hashStream(entry.chunks(), sha256);
    digests.set(path, { digest: toHex(digest), size });
  }
  return digests;
}

/** Returns whether every manifest file was available to hash. */
function checkIntegrity(
  documents: DocumentDigests,
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
    const document = documents.get(entry.path);
    if (document === undefined) {
      complete = false;
      report.files.push({ path: entry.path, status: "missing" });
      fail("missing-file", "File listed in the manifest is missing", entry.path);
    } else if (document.size !== entry.size || document.digest !== entry.hash) {
      report.files.push({ path: entry.path, status: "modified" });
      fail("modified-file", "File contents do not match the manifest", entry.path);
    } else {
      report.files.push({ path: entry.path, status: "valid" });
    }
  }
  for (const path of documents.keys()) {
    if (!listed.has(path)) {
      report.files.push({ path, status: "extra" });
      fail("extra-file", "File is not listed in the manifest", path);
    }
  }

  report.axes.integrity = report.issues.length === issuesBefore ? "valid" : "invalid";
  return complete;
}

interface SignatureOutcome {
  /** Every signature could be evaluated. */
  complete: boolean;
  valid: SignatureResult[];
  /** Digests of all parseable envelopes, for the seal. */
  digests: Uint8Array[];
}

async function checkSignatures(
  contents: Container,
  statementHash: Uint8Array,
  options: VerifyOptions,
  report: Omit<VerificationReport, "overall">,
): Promise<SignatureOutcome> {
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

  return { complete: !checks.includes("unsupported"), valid: validSigners, digests };
}

async function checkTrust(
  validSigners: readonly SignatureResult[],
  attestedAt: Date | null,
  options: VerifyOptions,
  report: Omit<VerificationReport, "overall">,
): Promise<void> {
  if (options.trust && report.axes.signature === "valid") {
    const verdicts: TrustResult["verdict"][] = [];
    for (const result of validSigners) {
      const outcome = await options.trust.evaluate(result.signer ?? "", { attestedAt });
      result.trust = outcome.verdict;
      if (outcome.reason !== undefined) {
        result.trustReason = outcome.reason;
      }
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
    // Every valid signer must be trusted: a pinned author next to an unknown "approver"
    // must not read as VALID, or the stranger's signature borrows the author's trust.
    report.axes.trust = verdicts.every((v) => v === "trusted")
      ? "trusted"
      : verdicts.includes("untrusted")
        ? "untrusted"
        : "unknown";
  }

}

interface TimeOutcome {
  complete: boolean;
  attestedAt: Date | null;
}

async function checkAnchors(
  contents: Container,
  statementHash: Uint8Array,
  envelopeDigests: readonly Uint8Array[],
  options: VerifyOptions,
  report: Omit<VerificationReport, "overall">,
): Promise<TimeOutcome> {
  const fail = (code: string, message: string, subject: string) => {
    report.issues.push({ axis: "time", code, message, subject });
  };
  let seal: Uint8Array | undefined;
  try {
    seal = sealDigest(statementHash, signaturesSetHash(envelopeDigests));
    report.seal = toHex(seal);
  } catch (error) {
    if (!(error instanceof FormatError)) {
      throw error;
    }
  }
  if (contents.anchors.size === 0) {
    report.axes.time = "missing";
    return { complete: true, attestedAt: null };
  }
  if (contents.anchors.size > 1) {
    report.axes.time = "invalid";
    fail("anchors", "v0.1 packages have at most one anchor file", "anchors/");
    return { complete: true, attestedAt: null };
  }

  const verdicts: AnchorResult["verdict"][] = [];
  let earliest: Date | null = null;
  for (const [entry, bytes] of contents.anchors) {
    let anchor;
    try {
      anchor = parseAnchorFile(parseJson(bytes));
    } catch (error) {
      if (!(error instanceof FormatError)) {
        throw error;
      }
      verdicts.push(error.verdict);
      fail(error.code, error.message, entry);
      continue;
    }
    const expectedEnvelopes = envelopeDigests.map(toHex).sort();
    if (
      seal === undefined ||
      anchor.seal !== toHex(seal) ||
      anchor.statementHash !== toHex(statementHash) ||
      anchor.envelopes.join() !== expectedEnvelopes.join()
    ) {
      verdicts.push("invalid");
      fail("seal", "Anchor does not cover this statement and these signatures", entry);
      continue;
    }

    for (const receipt of anchor.receipts) {
      const provider = options.anchors?.find((p) => p.id === receipt.provider);
      let result: AnchorResult;
      if (receipt.digest !== anchor.seal) {
        result = { verdict: "invalid", reason: "Receipt is for a different digest" };
      } else if (!provider) {
        result = { verdict: "unsupported", reason: `No registered anchor provider ${receipt.provider}` };
      } else if (!options.chain) {
        result = { verdict: "unsupported", reason: "No chain source configured" };
      } else {
        result = await provider.verify(receipt, seal, options.chain);
      }
      verdicts.push(result.verdict);
      report.anchors.push({
        entry,
        provider: receipt.provider,
        network: receipt.network,
        verdict: result.verdict,
        ...(result.attestedAt ? { attestedAt: result.attestedAt.toISOString() } : {}),
        ...(result.confirmations === undefined ? {} : { confirmations: result.confirmations }),
        ...(result.blockHeight === undefined ? {} : { blockHeight: result.blockHeight }),
        ...(typeof receipt.cached?.submittedAt === "string" ? { submittedAt: receipt.cached.submittedAt } : {}),
        ...(result.source === undefined ? {} : { source: result.source }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
      if (result.verdict !== "confirmed") {
        fail(result.verdict, result.reason ?? `Anchor is ${result.verdict}`, entry);
      } else if (result.attestedAt && (!earliest || result.attestedAt < earliest)) {
        earliest = result.attestedAt;
      }
    }
  }

  // One forged receipt makes the whole time claim untrustworthy.
  report.axes.time = verdicts.includes("invalid")
    ? "invalid"
    : earliest
      ? "confirmed"
      : verdicts.includes("pending")
        ? "pending"
        : "unsupported";
  if (earliest) {
    report.attestedAt = earliest.toISOString();
  }
  return { complete: !verdicts.includes("unsupported"), attestedAt: earliest };
}
