/**
 * The seal page of the built site in Chromium, Firefox, and WebKit. Run with `pnpm test:e2e`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readContainer } from "@docseal/core";
import { collectFiles } from "../../apps/cli/src/files";
import type { Io } from "../../apps/cli/src/io";
import { main } from "../../apps/cli/src/main";
import { ENGINE_NAMES, launch, Site } from "./site";

const PASSPHRASE = "correct horse battery";

/** Runs the CLI in-process with the passphrase in the environment. */
async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
    env: { DOCSEAL_PASSPHRASE: PASSPHRASE },
    readSecret: () => Promise.reject(new Error("no terminal in tests")),
  };
  return { code: await main(args, io), stdout };
}

let dir: string;
let cliKeyDid: string;
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
  // The default scrypt cost, as a user's key would have.
  const made = await cli(["keygen", "-o", join(dir, "cli.key")]);
  cliKeyDid = /Public key: (did:key:\S+)/.exec(made.stdout)?.[1] ?? "";
}, 60_000);
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

  it("opens a key file made by docseal keygen", async () => {
    const page = await open();
    await page.locator("[data-testid=key-file-input]").setInputFiles(join(dir, "cli.key"));
    await page.locator("input[name=passphrase]").fill("not the passphrase");
    await page.getByRole("button", { name: "Open the key" }).click();
    await page.locator(".key-panel [role=alert]").waitFor();

    await page.locator("input[name=passphrase]").fill(PASSPHRASE);
    const start = Date.now();
    await page.getByRole("button", { name: "Open the key" }).click();
    await page.locator("[data-testid=signing-as]").waitFor();
    console.log(`${name}: opened a key file (scrypt N = 2^17) in ${String(Date.now() - start)} ms`);
    expect(await page.locator("[data-testid=signing-as]").getAttribute("data-did")).toBe(cliKeyDid);
    // The passphrase is not kept in the form.
    await page.getByRole("button", { name: "Close the key" }).click();
    expect(await page.locator("input[name=passphrase]").inputValue()).toBe("");
    await site.expectClean(page);
    await page.close();
  });

  it("creates a key, downloads it at once, and the CLI signs with it", async () => {
    const context = await site.browser.newContext({ acceptDownloads: true });
    const page = await site.open("seal/", "[data-testid=files-input]", context);
    await page.getByRole("tab", { name: "Create a new key" }).click();
    await page.locator("input[name=new-passphrase]").fill("short");
    await page.locator("input[name=repeat-passphrase]").fill("short");
    await page.getByRole("button", { name: "Create and download the key" }).click();
    expect(await page.locator(".key-panel [role=alert]").innerText()).toMatch(/at least 8/);

    await page.locator("input[name=new-passphrase]").fill(PASSPHRASE);
    await page.locator("input[name=repeat-passphrase]").fill(PASSPHRASE);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create and download the key" }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("docseal.key");
    const keyPath = join(dir, `browser-${name}.key`);
    await saved.saveAs(keyPath);
    const did = await page.locator("[data-testid=signing-as]").getAttribute("data-did");
    expect(await page.locator("[data-testid=share-entry]").innerText()).toContain(did);

    await writeFile(join(dir, "doc.txt"), "document");
    const out = join(dir, `browser-${name}.dseal`);
    expect((await cli(["seal", join(dir, "doc.txt"), "-k", keyPath, "-o", out, "--no-anchor", "--force"])).code).toBe(0);
    const container = await readContainer(new Uint8Array(await readFile(out)));
    const envelope = JSON.parse(new TextDecoder().decode([...container.signatures.values()][0])) as { protected: { signer: string } };
    expect(envelope.protected.signer).toBe(did);
    await site.expectClean(page);
    await context.close();
  });
});
