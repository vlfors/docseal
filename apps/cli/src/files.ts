import { lstat, open, readdir, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { ByteSink, ByteSource, SealFile } from "@docseal/core";
import { CliError } from "./io.js";

/**
 * Collects the files to seal. A file argument is stored under its base name; a directory
 * argument contributes its contents, with paths relative to that directory.
 * Symlinks are refused rather than followed, so the package holds exactly what was named.
 * Contents are not loaded: each file is read in chunks while sealing.
 */
export async function collectFiles(paths: readonly string[]): Promise<SealFile[]> {
  const files: SealFile[] = [];
  for (const path of paths) {
    const stats = await statOrFail(path);
    if (stats.isSymbolicLink()) {
      throw new CliError(`${path} is a symbolic link; pass the target instead`);
    }
    if (stats.isFile()) {
      files.push({ path: basename(path), source: pathSource(path, stats.size) });
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
      files.push({ path: relative(root, full).split(sep).join("/"), source: pathSource(full, (await statOrFail(full)).size) });
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

/**
 * A file read by path. Each read opens the file anew, so sealing thousands of files never
 * holds thousands of descriptors; a file that shrinks or grows meanwhile is reported.
 */
function pathSource(path: string, size: number): ByteSource {
  return {
    size,
    async read(offset, length) {
      const handle = await open(path, "r").catch(() => {
        throw new CliError(`Cannot read ${path}`);
      });
      try {
        return await readExactly(handle, offset, length, path);
      } finally {
        await handle.close();
      }
    },
  };
}

export interface FileSource extends ByteSource {
  close(): Promise<void>;
}

/** An open file read at arbitrary offsets: a package being verified or upgraded. */
export async function openFileSource(path: string, what: string): Promise<FileSource> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new CliError(`Cannot read ${what} ${path}`);
  }
  const { size } = await handle.stat();
  return {
    size,
    read: (offset, length) => readExactly(handle, offset, length, path),
    close: () => handle.close(),
  };
}

async function readExactly(handle: FileHandle, offset: number, length: number, path: string): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) {
      throw new CliError(`${path} changed while it was being read`);
    }
    filled += bytesRead;
  }
  return buffer;
}

export async function readInput(path: string, what: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    throw new CliError(`Cannot read ${what} ${path}`);
  }
}

export interface OutputFile extends ByteSink {
  /** Moves the finished file into place. */
  commit(): Promise<void>;
  /** Removes the partial file. Safe to call after commit or more than once. */
  abort(): Promise<void>;
}

/**
 * Writes via a temporary file and a rename, so an interrupted run never leaves a
 * half-written package or key behind. Fails at once if `path` exists and may not be replaced.
 */
export async function createOutput(path: string, options: { overwrite: boolean; mode?: number }): Promise<OutputFile> {
  if (!options.overwrite && (await exists(path))) {
    throw new CliError(`${path} already exists; use --force to overwrite`);
  }
  const temporary = `${path}.tmp-${String(process.pid)}`;
  const fail = (error: unknown) => new CliError(`Cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`);
  let handle: FileHandle;
  try {
    handle = await open(temporary, "wx", options.mode ?? 0o644);
  } catch (error) {
    throw fail(error);
  }
  let done = false;
  return {
    async write(chunk) {
      try {
        await handle.write(chunk);
      } catch (error) {
        throw fail(error);
      }
    },
    async commit() {
      try {
        await handle.close();
        await rename(temporary, path);
        done = true;
      } catch (error) {
        await rm(temporary, { force: true });
        throw fail(error);
      }
    },
    async abort() {
      if (!done) {
        done = true;
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true });
      }
    },
  };
}

/** Runs `write` against a new output file, committing it on success and removing it on failure. */
export async function withOutput<T>(
  path: string,
  options: { overwrite: boolean; mode?: number },
  write: (sink: ByteSink) => Promise<T>,
): Promise<T> {
  const output = await createOutput(path, options);
  try {
    const result = await write(output);
    await output.commit();
    return result;
  } finally {
    await output.abort();
  }
}

export function writeOutput(path: string, data: Uint8Array, options: { overwrite: boolean; mode?: number }): Promise<void> {
  return withOutput(path, options, (sink) => sink.write(data));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
