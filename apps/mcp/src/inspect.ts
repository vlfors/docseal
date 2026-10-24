import { PROVIDER_ID, attestations, parseDetached } from "@docseal/anchor-ots";
import {
  fromBase64url,
  openContainer,
  parseAnchorFile,
  parseEnvelope,
  parseJson,
  parseManifest,
  parseStatement,
  type ByteSource,
} from "@docseal/core";
import type { InspectOutput } from "./schemas.js";

type Stage = InspectOutput["anchors"][number]["stage"];

/**
 * What a package holds, read without checking anything: no hashing, no signature or proof
 * verification, no network. A malformed package is refused with the core's own error.
 */
export async function inspectPackage(source: ByteSource): Promise<InspectOutput> {
  const container = await openContainer(source);
  const manifest = parseManifest(parseJson(container.manifest));
  const statement = parseStatement(parseJson(container.statement));
  const signatures = [...container.signatures].map(([entry, bytes]) => {
    const header = parseEnvelope(parseJson(bytes)).protected;
    return { entry, signer: header.signer, ...(header.role !== undefined && { role: header.role }), claimedAt: header.claimedAt };
  });
  const anchors: InspectOutput["anchors"] = [];
  for (const [entry, bytes] of container.anchors) {
    for (const receipt of parseAnchorFile(parseJson(bytes)).receipts) {
      anchors.push({ entry, provider: receipt.provider, ...(receipt.provider === PROVIDER_ID ? stageOf(receipt.proof) : { stage: "unreadable" }) });
    }
  }
  const title = manifest.metadata?.title;
  const files = manifest.files.map((file) => ({ path: file.path, size: file.size, ...(file.mediaType !== undefined && { mediaType: file.mediaType }) }));
  const timeProof = anchors.length === 0 ? "none" : furthest(anchors.map((anchor) => anchor.stage));
  return {
    summary:
      `The package holds ${count(files.length, "file")} and ${count(signatures.length, "signature")}; ` +
      `${TIME_PROOF[timeProof]} Nothing was checked: call verify for a verdict.`,
    verified: false,
    packageId: manifest.packageId,
    ...(typeof title === "string" && { title }),
    createdAt: statement.createdAt,
    files,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    signatures,
    timeProof,
    anchors,
  };
}

const TIME_PROOF: Record<InspectOutput["timeProof"], string> = {
  none: "it has no time proof.",
  pending: "its time proof was sent to the calendars and is not yet in Bitcoin.",
  "in-block": "its time proof names a Bitcoin block.",
  unreadable: "its time proof cannot be read.",
};

function stageOf(proof: string): { stage: Stage; blockHeight?: number } {
  try {
    const heights = attestations(parseDetached(fromBase64url(proof)).timestamp).flatMap(({ attestation }) =>
      attestation.kind === "bitcoin" ? [attestation.height] : [],
    );
    return heights.length === 0 ? { stage: "pending" } : { stage: "in-block", blockHeight: Math.min(...heights) };
  } catch {
    return { stage: "unreadable" };
  }
}

function furthest(stages: readonly Stage[]): InspectOutput["timeProof"] {
  if (stages.includes("in-block")) return "in-block";
  if (stages.includes("pending")) return "pending";
  return "unreadable";
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}
