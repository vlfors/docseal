/**
 * Shared parts of the end-to-end tests: the engines, the golden packages, and opening a page of
 * the built site with Content Security Policy violations recorded.
 */
import { readFile } from "node:fs/promises";
import type { AxisVerdicts } from "@docseal/core";
import { publicKeyToDid } from "@docseal/sig-ed25519";
import { ed25519 } from "@noble/curves/ed25519.js";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from "playwright";
import { expect, inject } from "vitest";
import { useFakeNetwork, type FakeNetwork } from "./network";

const PACKAGES = new URL("../../spec/vectors/packages/", import.meta.url);

export const golden = JSON.parse(await readFile(new URL("expected.json", PACKAGES), "utf8")) as {
  packages: { file: string; expected: { axes: AxisVerdicts; overall: string } }[];
};

export const goldenPath = (file: string): string => decodeURIComponent(new URL(file, PACKAGES).pathname);

/** The golden packages' signer: the RFC 8032 test 1 key (tests/vectors.test.ts). */
export const GOLDEN_SIGNER = publicKeyToDid(
  ed25519.getPublicKey(Uint8Array.from(Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"))),
);

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit };

/** DOCSEAL_E2E_BROWSERS limits the engines, e.g. "chromium,firefox". */
export const ENGINE_NAMES = (process.env.DOCSEAL_E2E_BROWSERS ?? "chromium,firefox,webkit").split(",");

export function launch(name: string): Promise<Browser> {
  const engine = ENGINES[name];
  if (!engine) {
    throw new Error(`unknown engine ${name}`);
  }
  return engine.launch();
}

/**
 * Opens pages of the site in one engine and records CSP violations. WebKit does not apply
 * 'unsafe-hashes' to style attributes, so it refuses the one inline style SvelteKit puts on its
 * route announcer (app.css hides the announcer anyway); a refused style is accepted there only
 * while the announcer is the one element with a style attribute, which `expectClean` checks.
 */
export class Site {
  readonly violations: string[] = [];
  private readonly styled = new Set<Page>();

  constructor(
    readonly engine: string,
    readonly browser: Browser,
  ) {}

  /**
   * A browser context on the fake network, with downloads accepted. `storage` is put into the
   * site's localStorage before its first page loads; by default Bitcoin checking is off, since
   * the golden packages' verdicts are defined offline.
   */
  async context(options: { storage?: Record<string, string>; network?: FakeNetwork; initScript?: string } = {}): Promise<{ context: BrowserContext; network: FakeNetwork }> {
    const context = await this.browser.newContext({ acceptDownloads: true });
    const network = await useFakeNetwork(context, inject("siteUrl"), options.network);
    const storage = { "docseal.chain": JSON.stringify({ mode: "offline", url: "" }), ...options.storage };
    // Only where nothing is stored yet: a choice the page saves survives a reload.
    await context.addInitScript((entries: Record<string, string>) => {
      try {
        for (const [key, value] of Object.entries(entries)) {
          if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
        }
      } catch {
        // A document without storage (about:blank, a refused origin).
      }
    }, storage);
    if (options.initScript) {
      await context.addInitScript(options.initScript);
    }
    return { context, network };
  }

  /** A page at `path` of the site, once `ready` is in the document; a new context unless given. */
  async open(path: string, ready: string, context?: BrowserContext): Promise<Page> {
    const page = await (context ?? (await this.context()).context).newPage();
    page.on("console", (message) => {
      const text = message.text();
      if (!/content.security.policy|refused to/i.test(text)) {
        return;
      }
      if (this.engine === "webkit" && /refused to apply a stylesheet/i.test(text)) {
        this.styled.add(page);
        return;
      }
      this.violations.push(text);
    });
    await page.goto(new URL(path, inject("siteUrl")).href);
    await page.locator(ready).waitFor({ state: "attached" });
    return page;
  }

  /** No CSP violation so far, and `page` carries no inline style but the announcer's. */
  async expectClean(page: Page): Promise<void> {
    expect(this.violations).toEqual([]);
    if (this.styled.has(page)) {
      expect(await page.locator("[style]:not(#svelte-announcer)").count()).toBe(0);
    }
  }
}
