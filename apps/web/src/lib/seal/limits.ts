/**
 * Where a sealed package is saved. With the File System Access API (Chrome, Edge) it is written
 * to the picked file as it is produced, whatever its size. Elsewhere (Firefox, Safari) it is
 * built in memory and downloaded, up to memoryLimit(); above it the page refuses and says why.
 */
const GiB = 1024 ** 3;

/**
 * The largest package built in memory, with room to spare below what was measured on
 * 2026-10-20 (tests/browser/memory.browser.test.ts): Firefox built and read back 3 GiB;
 * WebKit 1.5 GiB, and its tab crashed at 2 GiB; Chromium 1 GiB, but it never builds in memory.
 */
export function memoryLimit(userAgent: string): number {
  return /\bFirefox\//.test(userAgent) ? 2 * GiB : GiB;
}

export function canStreamToDisk(scope: object): scope is { showSaveFilePicker: (options?: object) => Promise<FileSystemFileHandle> } {
  return "showSaveFilePicker" in scope && typeof scope.showSaveFilePicker === "function";
}

/** A name to suggest for the package: one document's name, or a general one. */
export function suggestedName(paths: readonly string[]): string {
  const only = paths.length === 1 ? paths[0] : undefined;
  if (only === undefined) {
    return "package.dseal";
  }
  const base = only.slice(only.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return `${dot > 0 ? base.slice(0, dot) : base}.dseal`;
}
