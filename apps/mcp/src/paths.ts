import { UserError, fileSource, type FileSource } from "@docseal/node";
import { constants, type BigIntStats } from "node:fs";
import { open, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves a path an agent named to a real path under one of the --root directories, or
 * refuses it. Relative paths are taken from the first root. The path is checked as written
 * first, so nothing outside the roots is even looked up; then links are resolved and the
 * real path is checked again, so a link inside a root that points outside it is refused.
 *
 * Comparisons are exact. On a case-insensitive or normalising file system (macOS), a path
 * spelled differently from its root is refused rather than allowed: the check can be too
 * strict, never too lax. A hard link inside a root to a file elsewhere cannot be told apart
 * from that file; whoever can write into a root decides what is in it.
 */
export async function resolveInRoots(path: string, roots: readonly string[]): Promise<string> {
  const [first] = roots;
  if (first === undefined) {
    throw new UserError("No file access: the server was started without --root");
  }
  const named = resolve(first, path);
  if (!roots.some((root) => within(resolve(root), named))) {
    throw outside(path);
  }
  let real: string;
  try {
    real = await realpath(named);
  } catch {
    throw new UserError(`Cannot read ${path}`);
  }
  if (!(await withinRealRoots(roots, real))) {
    throw outside(path);
  }
  return real;
}

// Not following a final link, and not waiting on a FIFO or device that never answers.
const READ_FLAGS =
  constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0) | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0);

/**
 * Opens a regular file under the roots for reading. Between the check and the open, a
 * directory on the way could be swapped for a link; so the file opened is checked once more:
 * on Linux by the path the kernel reports for the descriptor, elsewhere by resolving the path
 * again and comparing the file's identity with the descriptor's. The result names the real
 * path it was opened at, so a caller writing next to it need not resolve the path again.
 */
export async function openInRoots(path: string, roots: readonly string[], what: string): Promise<FileSource & { real: string }> {
  const real = await resolveInRoots(path, roots);
  let handle: FileHandle;
  try {
    handle = await open(real, READ_FLAGS);
  } catch {
    throw new UserError(`Cannot read ${what} ${path}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new UserError(`${path} is not a regular file`);
    }
    if (!(await isOpenedWithin(handle, opened, real, roots))) {
      throw outside(path);
    }
    return Object.assign(await fileSource(handle, path), { real });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function isOpenedWithin(handle: FileHandle, opened: BigIntStats, real: string, roots: readonly string[]): Promise<boolean> {
  const kernelPath = await readlink(`/proc/self/fd/${String(handle.fd)}`).catch(() => undefined);
  if (kernelPath !== undefined && isAbsolute(kernelPath)) {
    return withinRealRoots(roots, kernelPath);
  }
  const again = await realpath(real).catch(() => undefined);
  const now = again === undefined ? undefined : await stat(again, { bigint: true }).catch(() => undefined);
  return again !== undefined && now !== undefined && now.dev === opened.dev && now.ino === opened.ino && (await withinRealRoots(roots, again));
}

async function withinRealRoots(roots: readonly string[], real: string): Promise<boolean> {
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => undefined);
    if (realRoot !== undefined && within(realRoot, real)) {
      return true;
    }
  }
  return false;
}

function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function outside(path: string): UserError {
  return new UserError(`${path} is outside the directories this server may read (--root)`);
}
