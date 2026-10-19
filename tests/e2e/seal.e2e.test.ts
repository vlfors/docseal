/**
 * The seal page of the built site in Chromium, Firefox, and WebKit. Run with `pnpm test:e2e`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectFiles } from "../../apps/cli/src/files";
import { ENGINE_NAMES, launch, Site } from "./site";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-e2e-seal-"));
  await mkdir(join(dir, "contract", "annex", "deep"), { recursive: true });
  await writeFile(join(dir, "contract", "main.pdf"), "main");
  await writeFile(join(dir, "contract", "annex", "приложение.txt"), "annex");
  await writeFile(join(dir, "contract", "annex", "deep", "x.bin"), "x");
  await mkdir(join(dir, "one"));
  await mkdir(join(dir, "two"));
  await writeFile(join(dir, "one", "Readme.md"), "a");
  await writeFile(join(dir, "two", "README.md"), "b");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.each(ENGINE_NAMES)("%s", (name) => {
  let site: Site;
  beforeAll(async () => {
    site = new Site(name, await launch(name));
  });
  afterAll(async () => {
    await site.browser.close();
  });

  const open = () => site.open("seal/", "[data-testid=files-input]");
  const paths = async (page: Page) => Promise.all((await page.locator(".planned li").all()).map((li) => li.getAttribute("data-path")));

  it("gives a chosen folder the package paths the CLI would", async () => {
    const page = await open();
    await page.locator("[data-testid=folder-input]").setInputFiles(join(dir, "contract"));
    await page.locator(".planned li").first().waitFor();
    const cli = (await collectFiles([join(dir, "contract")])).map((f) => f.path).sort();
    expect((await paths(page)).sort()).toEqual(cli);
    expect(await page.locator("[data-testid=files-summary]").innerText()).toMatch(/^3 file\(s\), 10 byte/);
    await site.expectClean(page);
    await page.close();
  });

  it("marks paths the core would reject before sealing, and lets them be removed", async () => {
    const page = await open();
    await page.locator("[data-testid=files-input]").setInputFiles([join(dir, "one", "Readme.md"), join(dir, "two", "README.md")]);
    await page.locator(".planned li").nth(1).waitFor();
    expect(await page.locator(".planned li[data-problem=collision]").count()).toBe(1);
    expect(await page.locator("[role=alert]").count()).toBe(1);
    await page.locator(".planned li[data-problem=collision] .remove").click();
    expect(await paths(page)).toHaveLength(1);
    expect(await page.locator("[role=alert]").count()).toBe(0);
    await site.expectClean(page);
    await page.close();
  });
});
