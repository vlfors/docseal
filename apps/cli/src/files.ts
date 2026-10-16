import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { SealFile } from "@docseal/core";
import { CliError } from "./io.js";

/**
 * Collects the files to seal. A file argument is stored under its base name; a directory
 * argument contributes its contents, with paths relative to that directory.
 * Symlinks are refused rather than followed, so the package holds exactly what was named.
 */
export async function collectFiles(paths: readonly string[]): Promise<SealFile[]> {
  const files: SealFile[] = [];
  for (const path of paths) {
    const stats = await statOrFail(path);
    if (stats.isSymbolicLink()) {
      throw new CliError(`${path} is a symbolic link; pass the target instead`);
    }
    if (stats.isFile()) {
      files.push({ path: basename(path), data: await readFile(path) });
    } else if (stats.isDirectory()) {
      await walk(path, path, files);
    } else {
      throw new CliError(`${path} is not a regular file or directory`);
    }
  }
  if (files.length === 0) {
    throw new CliError("Nothing to seal: no files found");
  }
  return files;
}

async function walk(root: string, dir: string, files: SealFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new CliError(`${full} is a symbolic link; DocSeal does not follow links`);
    }
    if (entry.isDirectory()) {
      await walk(root, full, files);
    } else if (entry.isFile()) {
      files.push({ path: relative(root, full).split(sep).join("/"), data: await readFile(full) });
    } else {
      throw new CliError(`${full} is not a regular file`);
    }
  }
}

async function statOrFail(path: string) {
  try {
    return await lstat(path);
  } catch {
    throw new CliError(`Cannot read ${path}`);
  }
}

export async function readInput(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    throw new CliError(`Cannot read ${what} ${path}`);
  }
}

/**
 * Writes via a temporary file and a rename, so an interrupted run never leaves a
 * half-written package or key behind.
 */
export async function writeOutput(
  path: string,
  data: Uint8Array,
  options: { overwrite: boolean; mode?: number },
): Promise<void> {
  if (!options.overwrite && (await exists(path))) {
    throw new CliError(`${path} already exists; use --force to overwrite`);
  }
  const temporary = `${path}.tmp-${String(process.pid)}`;
  try {
    await writeFile(temporary, data, { mode: options.mode ?? 0o644, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new CliError(`Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
