/**
 * Packages over 4 GiB (ZIP64) on the site: verified from disk in each engine, and sealed in
 * Chromium straight to a file, with the browser's peak memory recorded. Only with
 * DOCSEAL_LARGE_TESTS=1; DOCSEAL_LARGE_DIR names a directory on disk with about 9 GB free (the
 * default, the system's temporary directory, may be in memory):
 *
 *   DOCSEAL_LARGE_TESTS=1 DOCSEAL_LARGE_DIR=~/.cache/docseal-large pnpm test:e2e tests/e2e/large
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { useFakeNetwork } from "./network";
import { openKey, PICK_IN_OPFS } from "./pages";
import { ENGINE_NAMES, launch, Site } from "./site";
import { cli } from "./verifiers";

const LARGE = process.env.DOCSEAL_LARGE_TESTS === "1";
/** Just over 4 GiB, so sizes and offsets need ZIP64. */
const SIZE = 2 ** 32 + 64 * 1024 * 1024;
const GiB = 1024 ** 3;

/** Peak resident memory of the Playwright browsers' processes while `work` runs (Linux). */
async function peakMemory<T>(work: () => Promise<T>): Promise<{ result: T; peak: number }> {
  const run = promisify(execFile);
  let peak = 0;
  const sample = async () => {
    const { stdout } = await run("ps", ["-eo", "rss=,args="]).catch(() => ({ stdout: "" }));
    const kib = stdout
      .split("\n")
      .filter((line) => line.includes("ms-playwright"))
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] ?? 0), 0);
    peak = Math.max(peak, kib * 1024);
  };
  const timer = setInterval(() => void sample(), 500);
  try {
    return { result: await work(), peak };
  } finally {
    clearInterval(timer);
  }
}

let dir: string;
beforeAll(async () => {
  if (!LARGE) return;
  const base = process.env.DOCSEAL_LARGE_DIR?.replace(/^~/, process.env.HOME ?? "~") ?? tmpdir();
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(join(base, "docseal-e2e-large-"));
  // A sparse file: on disk it takes no space, and it reads as zeros.
  const big = await open(join(dir, "big.bin"), "w");
  await big.truncate(SIZE);
  await big.close();
  await cli(["keygen", "-o", join(dir, "fast.key"), "--scrypt-n", "1024"]);
  const sealed = await cli(["seal", join(dir, "big.bin"), "-k", join(dir, "fast.key"), "-o", join(dir, "large.dseal"), "--no-anchor"]);
  expect(sealed.code).toBe(0);
}, 600_000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.runIf(LARGE).each(ENGINE_NAMES)("%s", (name) => {
  let site: Site;
  beforeAll(async () => {
    site = new Site(name, await launch(name));
  });
  afterAll(async () => {
    await site.browser.close();
  });

  const integrity = async (page: Page) => {
    await page.locator(".report").waitFor({ timeout: 900_000 });
    return page.locator("[data-axis=integrity]").getAttribute("data-verdict");
  };

  it("verifies a package over 4 GiB from disk", { timeout: 900_000 }, async () => {
    const page = await site.open("", "[data-testid=package-input]");
    const size = (await stat(join(dir, "large.dseal"))).size;
    const start = Date.now();
    const { result, peak } = await peakMemory(async () => {
      await page.locator("[data-testid=package-input]").setInputFiles(join(dir, "large.dseal"));
      return integrity(page);
    });
    expect(result).toBe("valid");
    console.log(`${name}: verified ${(size / GiB).toFixed(2)} GiB in ${String(Math.round((Date.now() - start) / 1000))} s, browser peak ${(peak / GiB).toFixed(2)} GiB`);
    await site.expectClean(page);
    await page.close();
  });

  it.runIf(name === "chromium")("seals a package over 4 GiB straight to a file, then verifies it", { timeout: 1_800_000 }, async () => {
    // A profile on disk: the private file system of an ordinary test context lives in memory,
    // with a quota too small for the package. (A file picked by a viewer has no such quota.)
    const context = await chromium.launchPersistentContext(join(dir, "profile"));
    await useFakeNetwork(context, inject("siteUrl"));
    await context.addInitScript(PICK_IN_OPFS);
    await context.addInitScript(() => {
      localStorage.setItem("docseal.chain", JSON.stringify({ mode: "offline", url: "" }));
    });
    const page = await site.open("seal/", "[data-testid=files-input]", context);
    await page.locator("[data-testid=files-input]").setInputFiles(join(dir, "big.bin"));
    await openKey(page, join(dir, "fast.key"));
    await page.locator("input[name=timestamp]").uncheck();
    const start = Date.now();
    const { peak } = await peakMemory(async () => {
      await page.locator("[data-testid=seal-button]").click();
      // Done, or failed with a message: either ends the wait.
      await page.locator("[data-testid=sealed], [data-testid=seal-message]").first().waitFor({ timeout: 1_800_000 });
    });
    expect(await page.locator("[data-testid=seal-message]").count(), await page.locator(".seal-panel").innerText()).toBe(0);
    console.log(`${name}: sealed ${(SIZE / GiB).toFixed(2)} GiB in ${String(Math.round((Date.now() - start) / 1000))} s, browser peak ${(peak / GiB).toFixed(2)} GiB`);

    // The package is in the origin private file system; drop it onto the verify page.
    const verify = await site.open("", "[data-testid=package-input]", context);
    await verify.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle("big.dseal")).getFile();
      const data = new DataTransfer();
      data.items.add(file);
      document.querySelector(".dropzone")?.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    expect(await integrity(verify)).toBe("valid");
    expect(await verify.locator("[data-axis=format]").getAttribute("data-verdict")).toBe("valid");
    await site.expectClean(verify);
    await context.close();
  });
});
