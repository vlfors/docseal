import { hash } from "./bytes.js";
import { jcs } from "./json.js";

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

/** The manifest fields committed to by a leaf. `hash` and `salt` are lowercase hex. */
export interface LeafInput {
  path: string;
  size: number;
  hash: string;
  salt: string;
}

export function leafHash(entry: LeafInput): Uint8Array {
  const { path, size, hash: fileHash, salt } = entry;
  return hash(LEAF_PREFIX, jcs({ path, size, hash: fileHash, salt }));
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return hash(NODE_PREFIX, left, right);
}

/** Merkle tree head as in RFC 6962 §2.1, over leaf hashes already in manifest order. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) {
    throw new RangeError("A Merkle tree needs at least one leaf");
  }
  return treeHead(leaves, 0, leaves.length);
}

function treeHead(leaves: readonly Uint8Array[], start: number, end: number): Uint8Array {
  const n = end - start;
  if (n === 1) {
    const leaf = leaves[start];
    if (leaf === undefined) {
      throw new RangeError("Leaf index out of range");
    }
    return leaf;
  }
  const k = largestPowerOfTwoBelow(n);
  return nodeHash(treeHead(leaves, start, start + k), treeHead(leaves, start + k, end));
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
}
