/**
 * The files to seal, as the CLI collects them (apps/cli/src/files.ts): a chosen or dropped file
 * is stored under its name; a folder contributes its contents, with paths relative to that
 * folder. Paths are checked with the core's own rules before sealing, so every problem the core
 * would reject is shown on the list rather than as a failed seal.
 */
import { checkPathCollisions, comparePaths, FormatError, normalizePath } from "@docseal/core";

export interface ChosenFile {
  /** The path in the package, as collected (before NFC normalization). */
  path: string;
  file: File;
}

export type PathProblem = { kind: "invalid"; message: string } | { kind: "collision" };

export interface PlannedFile {
  /** The stored path: NFC, as the core writes it; the collected path if it is invalid. */
  path: string;
  file: File;
  problem?: PathProblem;
}

/** A folder chosen with <input webkitdirectory>: the path below the chosen folder. */
export function pathInChosenFolder(file: File): string {
  const relative = file.webkitRelativePath;
  const slash = relative.indexOf("/");
  return slash === -1 ? file.name : relative.slice(slash + 1);
}

/** The files of a folder chosen with <input webkitdirectory>. */
export function fromFolderInput(files: Iterable<File>): ChosenFile[] {
  return [...files].map((file) => ({ path: pathInChosenFolder(file), file }));
}

/** The files of <input type=file multiple>, each under its own name. */
export function fromFileInput(files: Iterable<File>): ChosenFile[] {
  return [...files].map((file) => ({ path: file.name, file }));
}

/** The parts of the File and Directory Entries API a drop gives, so a walk can be tested. */
export interface Entry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}
export interface FileEntry extends Entry {
  file(success: (file: File) => void, failure: (error: unknown) => void): void;
}
export interface DirectoryEntry extends Entry {
  createReader(): { readEntries(success: (entries: Entry[]) => void, failure: (error: unknown) => void): void };
}

const isFileEntry = (entry: Entry): entry is FileEntry => entry.isFile;
const isDirectoryEntry = (entry: Entry): entry is DirectoryEntry => entry.isDirectory;

async function walk(directory: DirectoryEntry, prefix: string, out: ChosenFile[]): Promise<void> {
  const reader = directory.createReader();
  // readEntries returns the entries in batches (100 at a time in Chromium) until an empty one.
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) {
      return;
    }
    for (const entry of batch) {
      await collect(entry, `${prefix}${entry.name}`, out);
    }
  }
}

async function collect(entry: Entry, path: string, out: ChosenFile[]): Promise<void> {
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject);
    });
    out.push({ path, file });
  } else if (isDirectoryEntry(entry)) {
    await walk(entry, `${path}/`, out);
  }
}

/** Dropped items: a file under its name, a folder by its contents relative to it. */
export async function fromDroppedEntries(entries: readonly Entry[]): Promise<ChosenFile[]> {
  const out: ChosenFile[] = [];
  for (const entry of entries) {
    if (isDirectoryEntry(entry)) {
      await walk(entry, "", out);
    } else {
      await collect(entry, entry.name, out);
    }
  }
  return out;
}

/** Index of the path at which checkPathCollisions first throws on `paths`, or -1. */
function firstCollision(paths: readonly string[]): number {
  const collides = (end: number) => {
    try {
      checkPathCollisions(paths.slice(0, end));
      return false;
    } catch (error) {
      if (error instanceof FormatError) {
        return true;
      }
      throw error;
    }
  };
  if (!collides(paths.length)) {
    return -1;
  }
  // The check throws at the first path that collides with one before it: the shortest prefix
  // that fails ends there.
  let low = 1;
  let high = paths.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (collides(middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low - 1;
}

/**
 * The files in the order of the manifest, each with the problem the core would reject it for:
 * an invalid path, or a path that collides with an earlier one (a duplicate, a case-insensitive
 * match, or a file used as a directory).
 */
export function planFiles(chosen: readonly ChosenFile[]): PlannedFile[] {
  const planned: PlannedFile[] = chosen.map(({ path, file }) => {
    try {
      return { path: normalizePath(path), file };
    } catch (error) {
      if (error instanceof FormatError) {
        return { path, file, problem: { kind: "invalid", message: error.message } };
      }
      throw error;
    }
  });
  planned.sort((a, b) => comparePaths(a.path, b.path));
  // Collisions among the valid paths, found with the core's own check, one at a time.
  let candidates = planned.filter((file) => !file.problem);
  for (;;) {
    const index = firstCollision(candidates.map((file) => file.path));
    const colliding = candidates[index];
    if (!colliding) {
      return planned;
    }
    colliding.problem = { kind: "collision" };
    candidates = candidates.filter((file) => file !== colliding);
  }
}

export function totalSize(files: readonly PlannedFile[]): number {
  return files.reduce((sum, file) => sum + file.file.size, 0);
}
