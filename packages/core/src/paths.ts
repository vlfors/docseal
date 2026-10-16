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
 *
 * Paths are compared both lowercased and uppercased: neither mapping alone matches what
 * file systems do (`ΟΔΟΣ` lowercases to a final `ς`, `ß` only uppercases to `SS`).
 * Treating either match as a collision may reject a harmless pair, never miss a real one.
 */
export function checkPathCollisions(paths: Iterable<string>): void {
  const folds = [(p: string) => p.toLowerCase(), (p: string) => p.toUpperCase()];
  const files = folds.map(() => new Set<string>());
  const directories = folds.map(() => new Set<string>());
  for (const path of paths) {
    folds.forEach((fold, i) => {
      const folded = fold(path);
      const fileSet = files[i] ?? new Set<string>();
      const directorySet = directories[i] ?? new Set<string>();
      if (fileSet.has(folded) || directorySet.has(folded)) {
        throw new FormatError("path-collision", `Path ${JSON.stringify(path)} collides with another path`);
      }
      fileSet.add(folded);
      const segments = folded.split("/");
      for (let j = 1; j < segments.length; j++) {
        const directory = segments.slice(0, j).join("/");
        if (fileSet.has(directory)) {
          throw new FormatError("path-collision", `Path ${JSON.stringify(path)} uses a file as a directory`);
        }
        directorySet.add(directory);
      }
    });
  }
}
