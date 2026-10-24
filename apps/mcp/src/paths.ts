import { UserError } from "@docseal/node";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolves a path an agent named to a real path under one of the --root directories, or
 * refuses it. Relative paths are taken from the first root. The path is checked as written
 * first, so nothing outside the roots is even looked up; then links are resolved and the
 * real path is checked again, so a link inside a root that points outside it is refused.
 */
export async function resolveInRoots(path: string, roots: readonly string[]): Promise<string> {
  const [first] = roots;
  if (first === undefined) {
    throw new UserError("No file access: the server was started without --root");
  }
  const outside = new UserError(`${path} is outside the directories this server may read (--root)`);
  const named = resolve(first, path);
  if (!roots.some((root) => within(resolve(root), named))) {
    throw outside;
  }
  let real: string;
  try {
    real = await realpath(named);
  } catch {
    throw new UserError(`Cannot read ${path}`);
  }
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => undefined);
    if (realRoot !== undefined && within(realRoot, real)) {
      return real;
    }
  }
  throw outside;
}

function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}
