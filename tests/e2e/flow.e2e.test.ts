/**
 * The whole round trip on the site in each engine: a package sealed on the Seal page is
 * verified on the Verify page, as trusted by its signer's key and as untrusted by anyone else,
 * and once a document in it is changed, it is invalid and the page names the document.
 * Run with `pnpm test:e2e`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContainer, utf8, writeContainer } from "@docseal/core";
import { publicKeyToDid } from "@docseal/sig-ed25519";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openKey, PICK_IN_OPFS, savedPackage } from "./pages";
import { ENGINE_NAMES, launch, Site } from "./site";
import { cli } from "./verifiers";

let dir: string;
let did: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-e2e-flow-"));
  const made = await cli(["keygen", "-o", join(dir, "fast.key"), "--scrypt-n", "1024"]);
  did = /Public key: (did:key:\S+)/.exec(made.stdout)?.[1] ?? "";
  await writeFile(join(dir, "agreement.txt"), "We agree.");
  await writeFile(join(dir, "annex.txt"), "Annex 1.");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const trusting = (id: string) => JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id, label: "Signer" }] });

describe.each(ENGINE_NAMES)("%s", (name) => {
  let site: Site;
  beforeAll(async () => {
    site = new Site(name, await launch(name));
  });
  afterAll(async () => {
    await site.browser.close();
  });

  /** The Verify page of a new context that trusts `trustedId`, showing the report for `path`. */
  async function verify(path: string, trustedId: string): Promise<Page> {
    const { context } = await site.context({ storage: { "docseal.trustedKeys": trusting(trustedId) } });
    const page = await site.open("", "[data-testid=package-input]", context);
    await page.locator("[data-testid=package-input]").setInputFiles(path);
    await page.locator(".report").waitFor();
    return page;
  }
  const verdicts = async (page: Page) => ({
    overall: await page.locator(".report").getAttribute("data-overall"),
    integrity: await page.locator("[data-axis=integrity]").getAttribute("data-verdict"),
    trust: await page.locator("[data-axis=trust]").getAttribute("data-verdict"),
  });

  it("seals, verifies as trusted and untrusted, and turns invalid when a document changes", { timeout: 120_000 }, async () => {
    const { context } = await site.context(name === "chromium" ? { initScript: PICK_IN_OPFS } : {});
    const seal = await site.open("seal/", "[data-testid=files-input]", context);
    await seal.locator("[data-testid=files-input]").setInputFiles([join(dir, "agreement.txt"), join(dir, "annex.txt")]);
    await openKey(seal, join(dir, "fast.key"));
    await seal.locator("input[name=timestamp]").uncheck();
    const download = name === "chromium" ? undefined : seal.waitForEvent("download");
    await seal.locator("[data-testid=seal-button]").click();
    await seal.locator("[data-testid=sealed]").waitFor();
    const path = join(dir, `sealed-${name}.dseal`);
    const bytes = await savedPackage(seal, download, "package.dseal", path);
    await site.expectClean(seal);
    await context.close();

    // Trusted by its signer's key; nothing is wrong, but there is no time proof.
    const trusted = await verify(path, did);
    expect(await verdicts(trusted)).toEqual({ overall: "indeterminate", integrity: "valid", trust: "trusted" });
    await site.expectClean(trusted);

    // Someone who trusts another key: untrusted, and the page says so.
    const stranger = publicKeyToDid(new Uint8Array(32).fill(3));
    const untrusted = await verify(path, stranger);
    expect(await verdicts(untrusted)).toEqual({ overall: "indeterminate", integrity: "valid", trust: "untrusted" });
    expect(await untrusted.locator("[data-axis=trust]").innerText()).toMatch(/not in the pinned key list/);

    // A document changed inside the package, the rest left as it was: invalid, and named.
    const contents = await readContainer(bytes);
    contents.files.set("agreement.txt", utf8("We do not agree."));
    const tampered = join(dir, `tampered-${name}.dseal`);
    await writeFile(tampered, await writeContainer(contents));
    const changed = await verify(tampered, did);
    expect(await verdicts(changed)).toMatchObject({ overall: "invalid", integrity: "invalid" });
    expect(await changed.locator(".files:not(.all) li[data-status=modified]").innerText()).toContain("agreement.txt");
    expect(await changed.locator("[data-issue]").count()).toBeGreaterThan(0);
    await site.expectClean(changed);
    // The package on disk is the sealed one, untouched by the test.
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
  });
});
