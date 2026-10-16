import { hash, utf8 } from "./bytes.js";
import { writeContainer } from "./container.js";
import { jsonHash, sealDigest, signaturesSetHash, signedBytes } from "./digests.js";
import { toBase64url, toHex } from "./encoding.js";
import { FormatError } from "./errors.js";
import { leafHash, merkleRoot } from "./merkle.js";
import {
  HASH_ALGORITHM,
  MERKLE_SCHEME,
  type AnchorFile,
  type FileEntry,
  type Manifest,
  type ProtectedHeader,
  type SignatureEnvelope,
  type Statement,
} from "./model.js";
import { checkPathCollisions, comparePaths, normalizePath } from "./paths.js";
import type { AnchorProvider, KeyProvider } from "./plugins.js";

const SALT_LENGTH = 16;

export interface SealFile {
  path: string;
  data: Uint8Array;
  mediaType?: string;
}

export interface SealOptions {
  files: readonly SealFile[];
  signer: KeyProvider;
  role?: string;
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  generator?: string;
  /** Providers the seal is submitted to. Without any, the package has no time proof yet. */
  anchors?: readonly AnchorProvider[];
  /** Clock and randomness are injectable for reproducible tests. */
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}

export interface SealResult {
  container: Uint8Array;
  manifest: Manifest;
  statement: Statement;
  envelope: SignatureEnvelope;
  anchor?: AnchorFile;
  /** Digest to submit to anchor providers, lowercase hex. */
  seal: string;
}

export async function sealPackage(options: SealOptions): Promise<SealResult> {
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  if (options.files.length === 0) {
    throw new FormatError("empty", "A package needs at least one file");
  }

  const files = options.files
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .sort((a, b) => comparePaths(a.path, b.path));
  checkPathCollisions(files.map((file) => file.path));

  const entries: FileEntry[] = files.map((file) => ({
    path: file.path,
    size: file.data.length,
    ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    hash: toHex(hash(file.data)),
    salt: toHex(randomBytes(SALT_LENGTH)),
  }));

  const manifest: Manifest = {
    type: "docseal-manifest",
    version: 1,
    packageId: uuidUrn(randomBytes(16)),
    hashAlgorithm: HASH_ALGORITHM,
    merkleScheme: MERKLE_SCHEME,
    files: entries,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.generator === undefined ? {} : { generator: options.generator }),
  };

  const statement: Statement = {
    type: "docseal-package-statement",
    version: 1,
    packageId: manifest.packageId,
    hashAlgorithm: HASH_ALGORITHM,
    merkleScheme: MERKLE_SCHEME,
    merkleRoot: toHex(merkleRoot(entries.map(leafHash))),
    manifestHash: toHex(jsonHash(manifest)),
    createdAt: timestamp(now()),
    previous: null,
    signaturePolicy: { type: "any-valid" },
    critical: [],
  };
  const statementHash = jsonHash(statement);

  const protectedHeader: ProtectedHeader = {
    type: "docseal-signature",
    version: 1,
    suite: options.signer.suite,
    profile: options.signer.profile,
    signer: await options.signer.getSigner(),
    ...(options.role === undefined ? {} : { role: options.role }),
    claimedAt: timestamp(now()),
    statementHash: toHex(statementHash),
    ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
    critical: [],
  };
  const envelope: SignatureEnvelope = {
    protected: protectedHeader,
    value: toBase64url(await options.signer.sign(signedBytes(protectedHeader))),
  };

  const envelopeDigest = jsonHash(envelope);
  const seal = sealDigest(statementHash, signaturesSetHash([envelopeDigest]));
  let anchor: AnchorFile | undefined;
  if (options.anchors && options.anchors.length > 0) {
    anchor = {
      type: "docseal-anchor",
      version: 1,
      seal: toHex(seal),
      statementHash: toHex(statementHash),
      envelopes: [toHex(envelopeDigest)],
      receipts: await Promise.all(options.anchors.map((provider) => provider.submit(seal))),
    };
  }

  const container = writeContainer({
    manifest: prettyJson(manifest),
    statement: prettyJson(statement),
    files: new Map(files.map((file) => [file.path, file.data])),
    signatures: new Map([["signatures/0001.json", prettyJson(envelope)]]),
    anchors: new Map<string, Uint8Array>(anchor ? [["anchors/seal-1.json", prettyJson(anchor)]] : []),
  });
  return { container, manifest, statement, envelope, ...(anchor ? { anchor } : {}), seal: toHex(seal) };
}

/** Stored JSON is human-readable; hashes never depend on formatting because they use JCS. */
export function prettyJson(value: unknown): Uint8Array {
  return utf8(`${JSON.stringify(value, null, 2)}\n`);
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function uuidUrn(random: Uint8Array): string {
  const bytes = random.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
