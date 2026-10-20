/** Steps on the site's pages that several end-to-end tests take. */
import { readFile, writeFile } from "node:fs/promises";
import type { Download, Page } from "playwright";
import { PASSPHRASE } from "./verifiers";

/**
 * Playwright cannot answer the native save dialog, so in Chromium it is replaced by one that
 * picks a file in the origin private file system: a real FileSystemFileHandle, written by the
 * worker through createWritable, as a file on disk would be.
 */
export const PICK_IN_OPFS = `
  window.showSaveFilePicker = async (options) => {
    const root = await navigator.storage.getDirectory();
    return root.getFileHandle(options.suggestedName, { create: true });
  };
`;

/** Opens the key file at `path` (made with PASSPHRASE) on the seal page. */
export async function openKey(page: Page, path: string): Promise<void> {
  await page.locator("[data-testid=key-file-input]").setInputFiles(path);
  await page.locator("input[name=passphrase]").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Open the key" }).click();
  await page.locator("[data-testid=signing-as]").waitFor();
}

/**
 * The bytes of a package the page saved, written to `file`: the download, or (Chromium) the
 * file named `name` in the origin private file system.
 */
export async function savedPackage(page: Page, download: Promise<Download> | undefined, name: string, file: string): Promise<Uint8Array> {
  if (download) {
    await (await download).saveAs(file);
    return new Uint8Array(await readFile(file));
  }
  const base64 = await page.evaluate(async (entry) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(entry);
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }, name);
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  await writeFile(file, bytes);
  return bytes;
}
