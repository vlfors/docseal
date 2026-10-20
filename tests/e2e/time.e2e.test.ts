/**
 * Time proofs in the browser, on the fake network of tests/e2e/network.ts: a package is sealed
 * and submitted to the calendars, shows as pending, is upgraded once Bitcoin "confirms" it, and
 * then verifies as valid, all on the site. Run with `pnpm test:e2e`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Signer } from "../../apps/web/src/lib/signer/run";
import { runVerification } from "../../apps/web/src/lib/verify/run";
import type { VerifyMessage } from "../../apps/web/src/lib/verify/protocol";
import { fakeNetwork } from "../fake-network";
import { openKey, PICK_IN_OPFS, savedPackage } from "./pages";
import { ENGINE_NAMES, launch, Site } from "./site";
import { cli } from "./verifiers";

const PUBLIC = JSON.stringify({ mode: "public", url: "" });

let dir: string;
let did: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-e2e-time-"));
  const made = await cli(["keygen", "-o", join(dir, "fast.key"), "--scrypt-n", "1024"]);
  did = /Public key: (did:key:\S+)/.exec(made.stdout)?.[1] ?? "";
  await writeFile(join(dir, "contract.txt"), "the contract");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const trusted = () => JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: did }] });

describe.each(ENGINE_NAMES)("%s", (name) => {
  let site: Site;
  beforeAll(async () => {
    site = new Site(name, await launch(name));
  });
  afterAll(async () => {
    await site.browser.close();
  });

  it("checks a confirmed proof against the chain source, from the worker", async () => {
    // A package made and upgraded in Node.js on the same fake network.
    const network = fakeNetwork();
    const messages: unknown[] = [];
    const signer = new Signer((m) => messages.push(m), () => 0, 2 ** 10, network.fetch);
    await signer.handle({ type: "open", keyFile: new Uint8Array(await readFile(join(dir, "fast.key"))), passphrase: "correct horse battery" });
    await signer.handle({ type: "seal", files: [{ path: "a.txt", file: new File(["a"], "a.txt") }], role: "author", output: { kind: "memory", limit: 1 << 20 }, timestamp: true });
    network.confirm();
    const upgraded: VerifyMessage[] = [];
    const sealed = messages.at(-1) as { blob: Blob };
    await runVerification({ type: "upgrade", file: sealed.blob, output: { kind: "memory", limit: 1 << 20 } }, (m) => upgraded.push(m), { fetch: network.fetch });
    const blob = (upgraded.at(-1) as { blob: Blob }).blob;
    const path = join(dir, `confirmed-${name}.dseal`);
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));

    const { context } = await site.context({ network, storage: { "docseal.chain": PUBLIC, "docseal.trustedKeys": trusted() } });
    const page = await site.open("", "[data-testid=package-input]", context);
    await page.locator("[data-testid=package-input]").setInputFiles(path);
    await page.locator(".report").waitFor();
    // The worker's requests went to the fake Esplora (under mempool.space's address).
    expect(network.requests).toContain("GET https://esplora.test/blocks/tip/height");
    expect(await page.locator(".report").getAttribute("data-overall")).toBe("valid");
    // The report names the source the worker asked, whose answers the fake network gave.
    expect(await page.locator("[data-axis=time]").textContent()).toMatch(/via\s+esplora https:\/\/mempool\.space\/api/);
    await site.expectClean(page);
    await context.close();
  });

  it("seals with a time proof, then upgrades it and verifies as valid, all in the browser", { timeout: 120_000 }, async () => {
    const { context, network } = await site.context({
      storage: { "docseal.chain": PUBLIC, "docseal.trustedKeys": trusted() },
      ...(name === "chromium" && { initScript: PICK_IN_OPFS }),
    });
    const seal = await site.open("seal/", "[data-testid=files-input]", context);
    await seal.locator("[data-testid=files-input]").setInputFiles(join(dir, "contract.txt"));
    await openKey(seal, join(dir, "fast.key"));
    expect(await seal.locator("input[name=timestamp]").isChecked()).toBe(true);
    const download = name === "chromium" ? undefined : seal.waitForEvent("download");
    await seal.locator("[data-testid=seal-button]").click();
    await seal.locator("[data-testid=sealed]").waitFor();
    // The calendars that allow requests from a browser, and only those.
    expect(await seal.locator("[data-testid=calendars]").innerText()).toMatch(/a\.pool\.opentimestamps\.org, b\.pool\.opentimestamps\.org, a\.pool\.eternitywall\.com$/);
    // The log shows the calendar step and each calendar's answer.
    expect(await seal.locator("[data-seal-step=timestamping]").getAttribute("data-state")).toBe("done");
    expect(await seal.locator("[data-calendar]").evaluateAll((items) => items.map((item) => `${item.getAttribute("data-calendar") ?? ""} ${item.getAttribute("data-accepted") ?? ""}`))).toEqual([
      "a.pool.opentimestamps.org true",
      "b.pool.opentimestamps.org true",
      "a.pool.eternitywall.com true",
    ]);
    const path = join(dir, `pending-${name}.dseal`);
    await savedPackage(seal, download, "contract.dseal", path);

    const verify = await site.open("", "[data-testid=package-input]", context);
    await verify.locator("[data-testid=package-input]").setInputFiles(path);
    await verify.locator("[data-axis=time][data-verdict=pending]").waitFor({ state: "attached" });
    // Sent to the calendars, waiting for a block.
    expect(await verify.locator(".upgrade-panel").getAttribute("data-stage")).toBe("submitted");
    expect(await verify.locator("[data-proof-stage=in-block]").getAttribute("class")).toContain("current");
    await verify.locator("[data-testid=upgrade-check]").click();
    await verify.locator("[data-testid=upgrade-not-yet]").waitFor();

    network.confirm();
    await verify.locator("[data-testid=upgrade-check]").click();
    // Checked against the chain: the block, and enough confirmations (the fake tip is 9 blocks on).
    await verify.locator("[data-testid=proof-block]").waitFor();
    expect(await verify.locator("[data-testid=proof-block]").innerText()).toContain("Block 900000");
    expect(await verify.locator("[data-testid=proof-block] a").getAttribute("href")).toBe("https://mempool.space/block/900000");
    expect(await verify.locator("[data-testid=proof-confirmations]").innerText()).toBe("6 of 6 confirmations");
    expect(await verify.locator(".upgrade-panel").getAttribute("data-stage")).toBe("confirmed");
    const saved = name === "chromium" ? undefined : verify.waitForEvent("download");
    await verify.locator("[data-testid=upgrade-save]").click();
    // The upgraded package is checked again at once.
    await verify.locator(".report[data-overall=valid]").waitFor();
    const upgraded = await savedPackage(verify, saved, `pending-${name}.dseal`, join(dir, `upgraded-${name}.dseal`));
    expect(upgraded.length).toBeGreaterThan(0);
    await site.expectClean(seal);
    await site.expectClean(verify);
    // The block is named in the report too.
    expect(await verify.locator("[data-testid=anchor-block]").textContent()).toContain("900000");
    await context.close();
  });

  it("checks again on its own every 10 minutes while asked to", { timeout: 120_000 }, async () => {
    const network = fakeNetwork();
    const messages: unknown[] = [];
    const signer = new Signer((m) => messages.push(m), () => 0, 2 ** 10, network.fetch);
    await signer.handle({ type: "open", keyFile: new Uint8Array(await readFile(join(dir, "fast.key"))), passphrase: "correct horse battery" });
    await signer.handle({ type: "seal", files: [{ path: "a.txt", file: new File(["a"], "a.txt") }], role: "author", output: { kind: "memory", limit: 1 << 20 }, timestamp: true });
    const path = join(dir, `auto-${name}.dseal`);
    await writeFile(path, new Uint8Array(await (messages.at(-1) as { blob: Blob }).blob.arrayBuffer()));

    const { context } = await site.context({ network, storage: { "docseal.chain": PUBLIC, "docseal.trustedKeys": trusted() } });
    await context.clock.install();
    const page = await site.open("", "[data-testid=package-input]", context);
    await page.locator("[data-testid=package-input]").setInputFiles(path);
    await page.locator("input[name=auto-check]").check();
    // Turning it on checks at once.
    await page.locator("[data-testid=upgrade-not-yet]").waitFor();
    const asked = () => network.requests.filter((request) => request.includes("/timestamp/")).length;
    const before = asked();

    network.confirm();
    await page.clock.fastForward("10:00");
    await page.locator("[data-testid=upgrade-save]").waitFor();
    expect(asked()).toBeGreaterThan(before);
    expect(await page.locator("[data-testid=proof-confirmations]").innerText()).toBe("6 of 6 confirmations");
    await site.expectClean(page);
    await context.close();
  });
});
