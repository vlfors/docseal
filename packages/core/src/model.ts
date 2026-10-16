/**
 * Data model of FORMAT-v0.1 and its validators.
 *
 * Validators check the fields DocSeal relies on and return the same object, typed.
 * Unknown fields are kept: hashes are always computed over the whole parsed value.
 */
import { FormatError } from "./errors.js";
import { checkPathCollisions, comparePaths, validatePath } from "./paths.js";
import type { AnchorReceipt } from "./plugins.js";

export const HASH_ALGORITHM = "sha-256";
export const MERKLE_SCHEME = "docseal-v1";

export interface FileEntry {
  path: string;
  size: number;
  mediaType?: string;
  /** SHA-256 of the file contents, lowercase hex. */
  hash: string;
  /** 16 random bytes, lowercase hex. */
  salt: string;
}

export interface Manifest {
  type: "docseal-manifest";
  version: 1;
  packageId: string;
  hashAlgorithm: typeof HASH_ALGORITHM;
  merkleScheme: typeof MERKLE_SCHEME;
  files: FileEntry[];
  metadata?: Record<string, unknown>;
  generator?: string;
}

export interface Statement {
  type: "docseal-package-statement";
  version: 1;
  packageId: string;
  hashAlgorithm: typeof HASH_ALGORITHM;
  merkleScheme: typeof MERKLE_SCHEME;
  merkleRoot: string;
  manifestHash: string;
  createdAt: string;
  previous: null;
  signaturePolicy: { type: "any-valid" };
  critical: string[];
}

export interface ProtectedHeader {
  type: "docseal-signature";
  version: 1;
  suite: string;
  profile: string;
  signer: string;
  role?: string;
  claimedAt: string;
  statementHash: string;
  attributes?: Record<string, unknown>;
  critical: string[];
}

export interface SignatureEnvelope {
  protected: ProtectedHeader;
  /** Signature bytes, base64url. */
  value: string;
}

export function parseManifest(value: unknown): Manifest {
  const m = record(value, "manifest");
  checkHeader(m, "manifest", "docseal-manifest");
  urnUuid(m.packageId, "manifest.packageId");
  checkAlgorithms(m, "manifest");
  if (m.metadata !== undefined) {
    record(m.metadata, "manifest.metadata");
  }
  optionalString(m.generator, "manifest.generator");

  const files = array(m.files, "manifest.files");
  if (files.length === 0) {
    throw invalid("manifest.files", "must contain at least one file");
  }
  let previous: string | undefined;
  for (const [i, item] of files.entries()) {
    const where = `manifest.files[${String(i)}]`;
    const entry = record(item, where);
    const path = string(entry.path, `${where}.path`);
    validatePath(path);
    if (previous !== undefined && comparePaths(previous, path) >= 0) {
      throw invalid(`${where}.path`, "files must be sorted by UTF-8 bytes of the path, without duplicates");
    }
    previous = path;
    integer(entry.size, `${where}.size`);
    hex(entry.hash, 32, `${where}.hash`);
    hex(entry.salt, 16, `${where}.salt`);
    optionalString(entry.mediaType, `${where}.mediaType`);
  }
  checkPathCollisions(files.map((entry) => (entry as FileEntry).path));
  return m as unknown as Manifest;
}

export function parseStatement(value: unknown): Statement {
  const s = record(value, "statement");
  checkHeader(s, "statement", "docseal-package-statement");
  checkCritical(s, "statement");
  urnUuid(s.packageId, "statement.packageId");
  checkAlgorithms(s, "statement");
  hex(s.merkleRoot, 32, "statement.merkleRoot");
  hex(s.manifestHash, 32, "statement.manifestHash");
  timestamp(s.createdAt, "statement.createdAt");
  if (s.previous !== null) {
    throw unsupported("statement.previous", "package versions are not supported in v0.1");
  }
  const policy = record(s.signaturePolicy, "statement.signaturePolicy");
  if (policy.type !== "any-valid") {
    throw unsupported("statement.signaturePolicy.type", "only 'any-valid' is supported in v0.1");
  }
  return s as unknown as Statement;
}

/**
 * Validates envelope structure. Unknown suites, profiles, and critical extensions are not
 * errors here: they make that one signature `unsupported` during verification.
 */
export function parseEnvelope(value: unknown): SignatureEnvelope {
  const e = record(value, "envelope");
  string(e.value, "envelope.value");
  const p = record(e.protected, "envelope.protected");
  if (p.type !== "docseal-signature") {
    throw invalid("envelope.protected.type", "expected 'docseal-signature'");
  }
  if (p.version !== 1) {
    throw unsupported("envelope.protected.version", "unsupported version");
  }
  string(p.suite, "envelope.protected.suite");
  string(p.profile, "envelope.protected.profile");
  string(p.signer, "envelope.protected.signer");
  optionalString(p.role, "envelope.protected.role");
  timestamp(p.claimedAt, "envelope.protected.claimedAt");
  hex(p.statementHash, 32, "envelope.protected.statementHash");
  if (p.attributes !== undefined) {
    record(p.attributes, "envelope.protected.attributes");
  }
  stringArray(p.critical, "envelope.protected.critical");
  return e as unknown as SignatureEnvelope;
}

export interface AnchorFile {
  type: "docseal-anchor";
  version: 1;
  /** Anchored digest, lowercase hex. */
  seal: string;
  statementHash: string;
  /** Digests of the envelopes covered by the seal, sorted, lowercase hex. */
  envelopes: string[];
  receipts: AnchorReceipt[];
}

export function parseAnchorFile(value: unknown): AnchorFile {
  const a = record(value, "anchor");
  checkHeader(a, "anchor", "docseal-anchor");
  hex(a.seal, 32, "anchor.seal");
  hex(a.statementHash, 32, "anchor.statementHash");
  const envelopes = stringArray(a.envelopes, "anchor.envelopes");
  envelopes.forEach((digest, i) => {
    hex(digest, 32, `anchor.envelopes[${String(i)}]`);
  });
  const receipts = array(a.receipts, "anchor.receipts");
  if (receipts.length === 0) {
    throw invalid("anchor.receipts", "must contain at least one receipt");
  }
  receipts.forEach((item, i) => {
    const where = `anchor.receipts[${String(i)}]`;
    const r = record(item, where);
    string(r.provider, `${where}.provider`);
    string(r.network, `${where}.network`);
    if (r.digestAlgorithm !== HASH_ALGORITHM) {
      throw unsupported(`${where}.digestAlgorithm`, `only '${HASH_ALGORITHM}' is supported`);
    }
    hex(r.digest, 32, `${where}.digest`);
    string(r.proof, `${where}.proof`);
    if (r.cached !== undefined) {
      record(r.cached, `${where}.cached`);
    }
  });
  return a as unknown as AnchorFile;
}

function checkHeader(o: Record<string, unknown>, where: string, type: string): void {
  if (o.type !== type) {
    throw invalid(`${where}.type`, `expected '${type}'`);
  }
  if (o.version !== 1) {
    throw unsupported(`${where}.version`, "unsupported version");
  }
}

function checkAlgorithms(o: Record<string, unknown>, where: string): void {
  if (o.hashAlgorithm !== HASH_ALGORITHM) {
    throw unsupported(`${where}.hashAlgorithm`, `only '${HASH_ALGORITHM}' is supported`);
  }
  if (o.merkleScheme !== MERKLE_SCHEME) {
    throw unsupported(`${where}.merkleScheme`, `only '${MERKLE_SCHEME}' is supported`);
  }
}

function checkCritical(o: Record<string, unknown>, where: string): void {
  const critical = stringArray(o.critical, `${where}.critical`);
  if (critical.length > 0) {
    throw unsupported(`${where}.critical`, `unknown critical extensions: ${critical.join(", ")}`);
  }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(where, "expected an object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(where, "expected an array");
  }
  return value;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw invalid(where, "expected a string");
  }
  return value;
}

function optionalString(value: unknown, where: string): void {
  if (value !== undefined) {
    string(value, where);
  }
}

function stringArray(value: unknown, where: string): string[] {
  const items = array(value, where);
  items.forEach((item, i) => string(item, `${where}[${String(i)}]`));
  return items as string[];
}

function integer(value: unknown, where: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(where, "expected a non-negative safe integer");
  }
}

function hex(value: unknown, bytes: number, where: string): void {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${String(bytes * 2)}}$`).test(value)) {
    throw invalid(where, `expected ${String(bytes)} bytes of lowercase hex`);
  }
}

const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function urnUuid(value: unknown, where: string): void {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw invalid(where, "expected a lowercase urn:uuid");
  }
}

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function timestamp(value: unknown, where: string): void {
  if (typeof value !== "string" || !RFC3339_UTC.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalid(where, "expected an RFC 3339 UTC timestamp ending in 'Z'");
  }
}

function invalid(where: string, message: string): FormatError {
  return new FormatError("schema", `${where}: ${message}`);
}

function unsupported(where: string, message: string): FormatError {
  return new FormatError("unsupported", `${where}: ${message}`, "unsupported");
}
