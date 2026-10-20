// Choosing where a package the page makes is saved: a picked file where the browser can write
// one as it is produced, else memory and a download (see seal/limits.ts).
import { MEDIA_TYPE } from "@docseal/core";
import type { PackageOutput } from "./output";
import { canStreamToDisk, MEMORY_LIMIT } from "./seal/limits";

export interface SaveTarget {
  output: PackageOutput;
  /** The name it is saved under: the picked file's, or the suggested one for a download. */
  name: string;
  /** The picked file, removed again if the package is not finished. */
  handle?: FileSystemFileHandle;
}

/** Asks where to save; undefined if the viewer dismissed the dialog. Call on a user's action. */
export async function chooseTarget(suggestedName: string): Promise<SaveTarget | undefined> {
  if (!canStreamToDisk(window)) {
    return { output: { kind: "memory", limit: MEMORY_LIMIT }, name: suggestedName };
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: "DocSeal package", accept: { [MEDIA_TYPE]: [".dseal"] } }] });
  } catch {
    return undefined;
  }
  return { output: { kind: "file", handle }, name: handle.name, handle };
}

/** Removes a picked file that did not receive a finished package (Chromium can). */
export async function discardTarget(target: SaveTarget | undefined): Promise<void> {
  const handle = target?.handle as (FileSystemFileHandle & { remove?: () => Promise<void> }) | undefined;
  await handle?.remove?.().catch(() => undefined);
}
