import { compareBytes, utf8 } from "./bytes.js";
import { FormatError } from "./errors.js";

export const MAX_PATH_BYTES = 1024;

// C0 controls, DEL, and backslash.
// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/;

/** Converts a path to its stored form (NFC) and validates it. Used when sealing. */
export function normalizePath(path: string): string {
  const normalized = path.normalize("NFC");
  validatePath(normalized);
  return normalized;
}

/** Checks a stored path. Verifiers never normalize: a non-NFC path is invalid. */
export function validatePath(path: string): void {
  const fail = (reason: string) => new FormatError("path", `Invalid path ${JSON.stringify(path)}: ${reason}`);
  if (!path.isWellFormed()) {
    throw fail("lone surrogate");
  }
  if (path !== path.normalize("NFC")) {
    throw fail("not in Unicode NFC");
  }
  if (FORBIDDEN.test(path)) {
    throw fail("control character or backslash");
  }
  if (utf8(path).length > MAX_PATH_BYTES) {
    throw fail(`longer than ${String(MAX_PATH_BYTES)} UTF-8 bytes`);
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw fail("empty, '.', or '..' segment, or a leading or trailing '/'");
    }
  }
}

/** Order of paths in the manifest and the Merkle tree: by UTF-8 bytes, not UTF-16 code units. */
export function comparePaths(a: string, b: string): number {
  return compareBytes(utf8(a), utf8(b));
}

/**
 * Rejects duplicates and paths that collide on case-insensitive file systems,
 * including a file that is also used as a directory (`a` and `a/b`).
 */
export function checkPathCollisions(paths: Iterable<string>): void {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    if (files.has(folded) || directories.has(folded)) {
      throw new FormatError("path-collision", `Path ${JSON.stringify(path)} collides with another path`);
    }
    files.add(folded);
    const segments = folded.split("/");
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join("/");
      if (files.has(directory)) {
        throw new FormatError("path-collision", `Path ${JSON.stringify(path)} uses a file as a directory`);
      }
      directories.add(directory);
    }
  }
}
