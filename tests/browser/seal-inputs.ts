/**
 * Fixed inputs for sealing the same package in Node.js and in each browser engine: documents
 * that are deflated, one that is stored (over 8 MiB), a Unicode path, a fixed clock, a fixed
 * key, and randomness derived from a counter.
 */
import { fromHex, hash, utf8 } from "@docseal/core";

export const NOW = new Date("2026-10-20T12:00:00Z");
/** RFC 8032 §7.1 TEST 1. */
export const SECRET_KEY = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");

export function inputs(): { path: string; file: Blob }[] {
  const big = new Uint8Array(9 * 1024 * 1024).map((_, i) => (i * 7) % 251);
  return [
    { path: "contract.pdf", file: new Blob([utf8("%PDF-1.7 ".repeat(1000))]) },
    { path: "annex/приложение 1.txt", file: new Blob([utf8("приложение\n")]) },
    { path: "data/large.bin", file: new Blob([big]) },
    { path: "empty", file: new Blob([]) },
  ];
}

/** SHA-256 of a label and a counter, as tests/vectors.test.ts makes randomness. */
export function randomBytes(): (length: number) => Uint8Array {
  let counter = 0;
  return (length) => hash(utf8(`browser determinism/${String(counter++)}`)).slice(0, length);
}
