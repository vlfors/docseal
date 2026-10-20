/**
 * The verify page of the built site in Chromium, Firefox, and WebKit: every golden package
 * shows the verdicts its vector requires, package text cannot disguise itself, and trusted keys
 * are kept, imported, and exported. Run with `pnpm test:e2e` (builds the site first).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealPackage, utf8 } from "@docseal/core";
import { memoryKeyProvider } from "@docseal/sig-ed25519";
import type { BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ENGINE_NAMES, golden, GOLDEN_SIGNER, goldenPath, launch, Site } from "./site";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-e2e-"));
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

  const open = (context?: BrowserContext) => site.open("", "[data-testid=package-input]", context);

  /** Chooses `path` and waits for its report; returns what the page shows. */
  async function check(page: Page, path: string) {
    await page.locator("[data-testid=package-input]").setInputFiles(path);
    const report = page.locator(".report");
    await report.waitFor();
    const axes: Record<string, string | null> = {};
    for (const row of await report.locator("[data-axis]").all()) {
      axes[(await row.getAttribute("data-axis")) ?? ""] = await row.getAttribute("data-verdict");
    }
    return { overall: await report.getAttribute("data-overall"), axes, text: await report.innerText() };
  }

  it("shows every golden package with the verdicts its vector requires", { timeout: 300_000 }, async () => {
    for (const { file, expected } of golden.packages) {
      const page = await open();
      const shown = await check(page, goldenPath(file));
      expect({ overall: shown.overall, axes: shown.axes }, file).toEqual(expected);
      if (expected.overall === "invalid") {
        // The reasons are on the page, not only the verdict.
        expect(await page.locator(".report [data-issue]").count(), `${file} shows its issues`).toBeGreaterThan(0);
      }
      if (file === "tampered-content.dseal") {
        // Words from the page and from the package stay apart (Svelte trims spaces at block edges).
        expect(shown.text).toMatch(/contract\.pdf:\s+File contents do not match/);
        expect(shown.text).toMatch(/…\w{6}\s\(author\)/);
      }
      await site.expectClean(page);
      await page.close();
    }
  });

  it("shows a bidirectional override in a file name as a visible code", async () => {
    const sealed = await sealPackage({
      files: [
        { path: "invoice\u202Etxt.exe", data: utf8("not a text file") },
        { path: "readme.txt", data: utf8("hello") },
      ],
      signer: memoryKeyProvider(new Uint8Array(32).fill(9)),
    });
    const path = join(dir, `bidi-${name}.dseal`);
    await writeFile(path, sealed.container);
    const page = await open();
    await check(page, path);
    await page.locator(".report details summary").first().click();
    const entry = page.locator(".files.all li").filter({ hasText: "invoice" });
    const text = await entry.innerText();
    expect(text).toContain("invoiceU+202Etxt.exe");
    expect(text).not.toContain("\u202E");
    await page.close();
  });

  it("evaluates trust with the viewer's keys, keeps them, and exports them", async () => {
    const { context } = await site.context();
    const page = await open(context);
    let shown = await check(page, goldenPath("valid-basic.dseal"));
    expect(shown.axes.trust).toBe("not-evaluated");
    expect(await page.locator("[data-hint=trustNotEvaluated]").count()).toBe(1);

    await page.locator("input[name=did]").fill(GOLDEN_SIGNER);
    await page.locator("input[name=label]").fill("RFC 8032 test key");
    await page.locator("form.add-key button[type=submit]").click();
    // Adding a key verifies the open package again.
    await page.locator("[data-axis=trust][data-verdict=trusted]").waitFor();

    // Kept in this browser: a new page of the same context still has the key.
    const again = await open(context);
    shown = await check(again, goldenPath("valid-basic.dseal"));
    expect(shown.axes.trust).toBe("trusted");

    const download = again.waitForEvent("download");
    await again.locator(".file-actions button").click();
    const exported = JSON.parse(await readFile(await (await download).path(), "utf8")) as { keys: { id: string; label?: string }[] };
    expect(exported.keys).toEqual([{ id: GOLDEN_SIGNER, label: "RFC 8032 test key" }]);
    await context.close();
  });

  it("imports a trusted-keys.json", async () => {
    const path = join(dir, `trusted-${name}.json`);
    await writeFile(path, JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: GOLDEN_SIGNER, label: "Imported" }] }));
    const page = await open();
    await page.locator(".trusted-keys input[type=file]").setInputFiles(path);
    await page.locator(`[data-key="${GOLDEN_SIGNER}"]`).waitFor();
    expect((await check(page, goldenPath("valid-basic.dseal"))).axes.trust).toBe("trusted");
    await page.close();
  });

  it("switches to Russian and remembers it", async () => {
    const page = await open();
    await page.getByRole("combobox", { name: /Language/ }).selectOption("ru");
    expect(await page.locator("html").getAttribute("lang")).toBe("ru");
    expect((await check(page, goldenPath("tampered-content.dseal"))).text).toContain("Недействителен");
    await page.reload();
    await page.locator("html[lang=ru]").waitFor({ state: "attached" });
    await page.close();
  });

  it("refuses to work inside a frame", async () => {
    const page = await (await site.context()).context.newPage();
    await page.setContent(`<iframe src="${inject("siteUrl")}"></iframe>`);
    const frame = page.frameLocator("iframe");
    await frame.locator("main p").first().waitFor();
    expect(await frame.locator("[data-testid=package-input]").count()).toBe(0);
    await page.close();
  });
});
