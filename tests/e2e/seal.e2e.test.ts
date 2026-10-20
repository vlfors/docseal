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
import { openKey, PICK_IN_OPFS, savedPackage } from "./pages";
import { ENGINE_NAMES, launch, Site } from "./site";
import { cli, hasPython, PASSPHRASE, verifyWithCli, verifyWithPython } from "./verifiers";

let dir: string;
let cliKeyDid: string;
let fastKeyDid: string;
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
  // A cheap key for the sealing tests, and recipients who trust it.
  const fast = await cli(["keygen", "-o", join(dir, "fast.key"), "--scrypt-n", "1024"]);
  fastKeyDid = /Public key: (did:key:\S+)/.exec(fast.stdout)?.[1] ?? "";
  await writeFile(join(dir, "trusted-keys.json"), JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: fastKeyDid }] }));
  await writeFile(join(dir, "large.bin"), new Uint8Array(96 * 1024 * 1024).map((_, i) => i % 251));
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
    // The key is step 2: it opens once documents are chosen.
    expect(await page.locator("[data-step='2']").getAttribute("data-state")).toBe("waiting");
    await page.locator("[data-testid=files-input]").setInputFiles(join(dir, "contract", "main.pdf"));
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
    const { context } = await site.context();
    const page = await site.open("seal/", "[data-testid=files-input]", context);
    await page.locator("[data-testid=files-input]").setInputFiles(join(dir, "contract", "main.pdf"));
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

  /** The seal page with the cheap key open and `files` chosen; downloads accepted. */
  async function ready(files: string[]) {
    const { context } = await site.context(name === "chromium" ? { initScript: PICK_IN_OPFS } : {});
    const page = await site.open("seal/", "[data-testid=files-input]", context);
    expect(await page.locator("[data-step='3']").getAttribute("data-state")).toBe("waiting");
    await page.locator("[data-testid=files-input]").setInputFiles(files);
    expect(await page.locator("[data-step='3'] .step-waiting").innerText()).toMatch(/signing key/);
    await openKey(page, join(dir, "fast.key"));
    // These packages carry no time proof; tests/e2e/time.e2e.test.ts covers the calendars.
    await page.locator("input[name=timestamp]").uncheck();
    return { context, page };
  }

  it("seals and saves a package that the CLI and the Python verifier accept", { timeout: 120_000 }, async () => {
    const { context, page } = await ready([join(dir, "contract", "main.pdf"), join(dir, "contract", "annex", "приложение.txt")]);
    await page.locator("input[name=role]").fill("approver");
    const download = name === "chromium" ? undefined : page.waitForEvent("download");
    await page.locator("[data-testid=seal-button]").click();
    await page.locator("[data-testid=sealed]").waitFor();
    // One key, one sealing: the key is closed.
    expect(await page.locator("[data-testid=signing-as]").count()).toBe(0);
    // The log keeps every step, all done; without a time proof there is no calendar step.
    const steps = page.locator("[data-testid=seal-log] [data-seal-step]");
    expect(await steps.evaluateAll((items) => items.map((item) => `${item.getAttribute("data-seal-step") ?? ""} ${item.getAttribute("data-state") ?? ""}`))).toEqual([
      "hashing done",
      "signing done",
      "writing done",
    ]);

    const file = join(dir, `sealed-${name}.dseal`);
    const bytes = await savedPackage(page, download, "package.dseal", file);
    const accepted = { format: "valid", integrity: "valid", signature: "valid", trust: "trusted", time: "missing", completeness: "full" };
    expect(await verifyWithCli(file, join(dir, "trusted-keys.json"))).toEqual(accepted);
    if (hasPython) {
      expect(await verifyWithPython(file, join(dir, "trusted-keys.json"))).toEqual(accepted);
    }
    const container = await readContainer(bytes);
    const envelope = JSON.parse(new TextDecoder().decode([...container.signatures.values()][0])) as { protected: { role: string; signer: string } };
    expect(envelope.protected).toMatchObject({ role: "approver", signer: fastKeyDid });
    expect(await page.locator("[data-testid=sealed]").getAttribute("data-seal")).toMatch(/^[0-9a-f]{64}$/);

    // Nothing of the key or the documents is stored: only the viewer's three settings.
    const stored = await page.evaluate(async () => ({
      keys: Object.keys(localStorage).sort(),
      values: Object.values(localStorage).join("\n"),
      databases: "databases" in indexedDB ? (await indexedDB.databases()).length : 0,
      url: location.href,
    }));
    expect(stored.keys.every((key) => ["docseal.chain", "docseal.language", "docseal.trustedKeys"].includes(key))).toBe(true);
    expect(stored.values).not.toContain(PASSPHRASE);
    expect(stored.values).not.toContain("ciphertext");
    expect(stored.databases).toBe(0);
    expect(stored.url).not.toMatch(/[?#]/);
    await site.expectClean(page);
    await context.close();
  });

  it("cancels sealing at once and leaves no package", { timeout: 120_000 }, async () => {
    const { context, page } = await ready([join(dir, "large.bin")]);
    let downloaded = false;
    page.on("download", () => {
      downloaded = true;
    });
    await page.locator("[data-testid=seal-button]").click();
    await page.locator("[data-state=sealing]").waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await page.locator("[data-testid=seal-message]").innerText()).toMatch(/cancelled/);
    expect(await page.locator("[data-testid=signing-as]").count()).toBe(0);
    await page.waitForTimeout(1000);
    expect(downloaded).toBe(false);
    if (name === "chromium") {
      const left = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const key of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(key);
        return names;
      });
      expect(left).toEqual([]);
    }
    await site.expectClean(page);
    await context.close();
  });
});
