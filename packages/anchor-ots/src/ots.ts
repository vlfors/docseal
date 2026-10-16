/**
 * The OpenTimestamps proof format: parsing, serialization, execution, and merging.
 *
 * Follows python-opentimestamps (the reference implementation). This is a serialization
 * format for a tree of operations; the hash functions themselves come from @noble/hashes.
 */
import { compareBytes, equalBytes, toHex, utf8 } from "@docseal/core";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const HEADER_MAGIC = Uint8Array.from([
  0x00, ...utf8("OpenTimestamps"), 0x00, 0x00, ...utf8("Proof"), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const MAJOR_VERSION = 1;

const MAX_MESSAGE_LENGTH = 4096;
const MAX_ARG_LENGTH = 4096;
const MAX_PAYLOAD_LENGTH = 8192;
const MAX_URI_LENGTH = 1000;
const MAX_DEPTH = 256;
const URI_CHARS = /^[A-Za-z0-9\-._/:]*$/;

const BITCOIN_TAG = Uint8Array.of(0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01);
const PENDING_TAG = Uint8Array.of(0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e);

export type UnaryOp = "sha1" | "ripemd160" | "sha256" | "keccak256" | "reverse" | "hexlify";
export type Op = { kind: UnaryOp } | { kind: "append" | "prepend"; arg: Uint8Array };

export type Attestation =
  | { kind: "bitcoin"; height: number }
  | { kind: "pending"; uri: string }
  | { kind: "unknown"; tag: Uint8Array; payload: Uint8Array };

export interface Timestamp {
  /** The message at this node: the input digest for the root, an op result below it. */
  msg: Uint8Array;
  attestations: Attestation[];
  ops: { op: Op; next: Timestamp }[];
}

export interface DetachedTimestamp {
  hashOp: "sha256";
  timestamp: Timestamp;
}

export class OtsError extends Error {
  override readonly name = "OtsError";
}

const UNARY_TAGS: Record<number, UnaryOp> = {
  0x02: "sha1",
  0x03: "ripemd160",
  0x08: "sha256",
  0x67: "keccak256",
  0xf2: "reverse",
  0xf3: "hexlify",
};
const OP_TAGS: Record<Op["kind"], number> = {
  sha1: 0x02,
  ripemd160: 0x03,
  sha256: 0x08,
  keccak256: 0x67,
  append: 0xf0,
  prepend: 0xf1,
  reverse: 0xf2,
  hexlify: 0xf3,
};

/**
 * Ops DocSeal does not execute: SHA-1 has practical collisions, so it cannot carry a time proof.
 * RIPEMD-160 is kept: it has no known practical attacks and early Bitcoin proofs (2015–2016) use it.
 */
const WEAK_OPS = new Set<Op["kind"]>(["sha1"]);

/**
 * Applies `op` to `msg`. Returns `null` for SHA-1, whose subtrees are ignored.
 */
export function applyOp(op: Op, msg: Uint8Array): Uint8Array | null {
  let result: Uint8Array;
  switch (op.kind) {
    case "append":
      result = new Uint8Array([...msg, ...op.arg]);
      break;
    case "prepend":
      result = new Uint8Array([...op.arg, ...msg]);
      break;
    case "sha256":
      result = sha256(msg);
      break;
    case "keccak256":
      result = keccak_256(msg);
      break;
    case "reverse":
      result = msg.slice().reverse();
      break;
    case "hexlify":
      result = utf8(toHex(msg));
      break;
    case "ripemd160":
      result = ripemd160(msg);
      break;
    case "sha1":
      return null;
  }
  if (result.length > MAX_MESSAGE_LENGTH) {
    throw new OtsError("Operation result is too long");
  }
  return result;
}

export function isWeakOp(op: Op): boolean {
  return WEAK_OPS.has(op.kind);
}

// ---------------------------------------------------------------------------
// Parsing

class Reader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    const value = this.bytes[this.pos];
    if (value === undefined) {
      throw new OtsError("Unexpected end of proof");
    }
    this.pos++;
    return value;
  }

  take(length: number): Uint8Array {
    if (this.pos + length > this.bytes.length) {
      throw new OtsError("Unexpected end of proof");
    }
    const out = this.bytes.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /** Unsigned LEB128, limited to safe integers. */
  varuint(): number {
    let value = 0;
    let multiplier = 1;
    for (;;) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(value)) {
        throw new OtsError("Integer too large");
      }
      if (!(byte & 0x80)) {
        return value;
      }
      multiplier *= 128;
    }
  }

  varbytes(maxLength: number, minLength = 0): Uint8Array {
    const length = this.varuint();
    if (length > maxLength || length < minLength) {
      throw new OtsError("Byte string length out of range");
    }
    return this.take(length);
  }

  assertEnd(): void {
    if (this.pos !== this.bytes.length) {
      throw new OtsError("Unexpected data after the proof");
    }
  }
}

export function parseDetached(bytes: Uint8Array): DetachedTimestamp {
  const reader = new Reader(bytes);
  if (!equalBytes(reader.take(HEADER_MAGIC.length), HEADER_MAGIC)) {
    throw new OtsError("Not an OpenTimestamps proof");
  }
  if (reader.varuint() !== MAJOR_VERSION) {
    throw new OtsError("Unsupported OpenTimestamps version");
  }
  if (reader.byte() !== OP_TAGS.sha256) {
    throw new OtsError("Only SHA-256 file digests are supported");
  }
  const timestamp = readTimestamp(reader, reader.take(32), MAX_DEPTH);
  reader.assertEnd();
  return { hashOp: "sha256", timestamp };
}

/** Parses a bare timestamp, as returned by calendar servers, for the given starting message. */
export function parseTimestamp(bytes: Uint8Array, msg: Uint8Array): Timestamp {
  const reader = new Reader(bytes);
  const timestamp = readTimestamp(reader, msg, MAX_DEPTH);
  reader.assertEnd();
  return timestamp;
}

function readTimestamp(reader: Reader, msg: Uint8Array, depth: number): Timestamp {
  if (depth < 0) {
    throw new OtsError("Proof is nested too deeply");
  }
  const timestamp: Timestamp = { msg, attestations: [], ops: [] };
  const readBranch = (tag: number) => {
    if (tag === 0x00) {
      timestamp.attestations.push(readAttestation(reader));
      return;
    }
    const op = readOp(reader, tag);
    // Weak ops still have to be parsed to reach the rest of the proof; their results are
    // replaced by an empty message, and nothing below them is ever trusted.
    const next = applyOp(op, msg) ?? new Uint8Array();
    timestamp.ops.push({ op, next: readTimestamp(reader, next, depth - 1) });
  };
  let tag = reader.byte();
  while (tag === 0xff) {
    readBranch(reader.byte());
    tag = reader.byte();
  }
  readBranch(tag);
  return timestamp;
}

function readOp(reader: Reader, tag: number): Op {
  if (tag === OP_TAGS.append || tag === OP_TAGS.prepend) {
    return { kind: tag === OP_TAGS.append ? "append" : "prepend", arg: reader.varbytes(MAX_ARG_LENGTH, 1) };
  }
  const kind = UNARY_TAGS[tag];
  if (kind === undefined) {
    throw new OtsError(`Unknown operation 0x${tag.toString(16)}`);
  }
  return { kind };
}

function readAttestation(reader: Reader): Attestation {
  const tag = reader.take(8);
  const payload = reader.varbytes(MAX_PAYLOAD_LENGTH);
  const inner = new Reader(payload);
  if (equalBytes(tag, BITCOIN_TAG)) {
    const height = inner.varuint();
    inner.assertEnd();
    return { kind: "bitcoin", height };
  }
  if (equalBytes(tag, PENDING_TAG)) {
    const uri = new TextDecoder().decode(inner.varbytes(MAX_URI_LENGTH));
    inner.assertEnd();
    if (!URI_CHARS.test(uri)) {
      throw new OtsError("Calendar URI contains forbidden characters");
    }
    return { kind: "pending", uri };
  }
  return { kind: "unknown", tag, payload };
}

// ---------------------------------------------------------------------------
// Serialization

class Writer {
  private readonly parts: number[] = [];

  bytes(data: Uint8Array): void {
    for (const byte of data) {
      this.parts.push(byte);
    }
  }

  byte(value: number): void {
    this.parts.push(value);
  }

  varuint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.parts.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.parts.push(rest);
  }

  varbytes(data: Uint8Array): void {
    this.varuint(data.length);
    this.bytes(data);
  }

  result(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export function serializeDetached(detached: DetachedTimestamp): Uint8Array {
  const writer = new Writer();
  writer.bytes(HEADER_MAGIC);
  writer.varuint(MAJOR_VERSION);
  writer.byte(OP_TAGS.sha256);
  writer.bytes(detached.timestamp.msg);
  writeTimestamp(writer, detached.timestamp);
  return writer.result();
}

/** A bare timestamp, as calendar servers return it. Inverse of {@link parseTimestamp}. */
export function serializeTimestamp(timestamp: Timestamp): Uint8Array {
  const writer = new Writer();
  writeTimestamp(writer, timestamp);
  return writer.result();
}

function writeTimestamp(writer: Writer, timestamp: Timestamp): void {
  const attestations = [...timestamp.attestations].sort(compareAttestations);
  const ops = [...timestamp.ops].sort((a, b) => compareOps(a.op, b.op));
  if (attestations.length === 0 && ops.length === 0) {
    throw new OtsError("An empty timestamp cannot be serialized");
  }
  const branches: (() => void)[] = [
    ...attestations.map((attestation) => () => {
      writer.byte(0x00);
      writeAttestation(writer, attestation);
    }),
    ...ops.map(({ op, next }) => () => {
      writeOp(writer, op);
      writeTimestamp(writer, next);
    }),
  ];
  branches.forEach((branch, i) => {
    if (i < branches.length - 1) {
      writer.byte(0xff);
    }
    branch();
  });
}

function writeOp(writer: Writer, op: Op): void {
  writer.byte(OP_TAGS[op.kind]);
  if (op.kind === "append" || op.kind === "prepend") {
    writer.varbytes(op.arg);
  }
}

function writeAttestation(writer: Writer, attestation: Attestation): void {
  const payload = new Writer();
  switch (attestation.kind) {
    case "bitcoin":
      writer.bytes(BITCOIN_TAG);
      payload.varuint(attestation.height);
      break;
    case "pending":
      writer.bytes(PENDING_TAG);
      payload.varbytes(utf8(attestation.uri));
      break;
    case "unknown":
      writer.bytes(attestation.tag);
      payload.bytes(attestation.payload);
      break;
  }
  writer.varbytes(payload.result());
}

function attestationKey(attestation: Attestation): [Uint8Array, Uint8Array] {
  switch (attestation.kind) {
    case "bitcoin": {
      const w = new Writer();
      w.varuint(attestation.height);
      return [BITCOIN_TAG, w.result()];
    }
    case "pending":
      return [PENDING_TAG, utf8(attestation.uri)];
    case "unknown":
      return [attestation.tag, attestation.payload];
  }
}

function compareAttestations(a: Attestation, b: Attestation): number {
  const [tagA, payloadA] = attestationKey(a);
  const [tagB, payloadB] = attestationKey(b);
  return compareBytes(tagA, tagB) || compareBytes(payloadA, payloadB);
}

function compareOps(a: Op, b: Op): number {
  const byTag = OP_TAGS[a.kind] - OP_TAGS[b.kind];
  if (byTag !== 0) {
    return byTag;
  }
  return "arg" in a && "arg" in b ? compareBytes(a.arg, b.arg) : 0;
}

// ---------------------------------------------------------------------------
// Merging and walking

/** Adds everything from `other` into `target`. Both must start from the same message. */
export function mergeTimestamps(target: Timestamp, other: Timestamp): void {
  if (!equalBytes(target.msg, other.msg)) {
    throw new OtsError("Cannot merge timestamps for different messages");
  }
  for (const attestation of other.attestations) {
    if (!target.attestations.some((existing) => compareAttestations(existing, attestation) === 0)) {
      target.attestations.push(attestation);
    }
  }
  for (const branch of other.ops) {
    const existing = target.ops.find((candidate) => compareOps(candidate.op, branch.op) === 0);
    if (existing) {
      mergeTimestamps(existing.next, branch.next);
    } else {
      target.ops.push(branch);
    }
  }
}

export interface AttestationAt {
  attestation: Attestation;
  /** Message the attestation commits to. */
  msg: Uint8Array;
  /** Node holding the attestation, for upgrades. */
  node: Timestamp;
}

/** All attestations reachable without passing through SHA-1. */
export function attestations(timestamp: Timestamp): AttestationAt[] {
  const found: AttestationAt[] = [];
  const visit = (node: Timestamp) => {
    for (const attestation of node.attestations) {
      found.push({ attestation, msg: node.msg, node });
    }
    for (const { op, next } of node.ops) {
      if (!isWeakOp(op)) {
        visit(next);
      }
    }
  };
  visit(timestamp);
  return found;
}
