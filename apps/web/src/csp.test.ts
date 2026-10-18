import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DEFAULT_CALENDARS, DEFAULT_ESPLORA_URLS, DEFAULT_UPGRADE_ALLOWLIST } from "@docseal/anchor-ots";
import { describe, expect, it } from "vitest";
import { ANNOUNCER_STYLE_HASH, CSP_DIRECTIVES } from "../csp.js";
import { BROWSER_CALENDARS, CHAIN_ORIGINS, CONNECT_SOURCES, UPGRADE_HOSTS } from "../network.js";

describe("content security policy", () => {
  it("allows exactly the inline style of SvelteKit's route announcer", () => {
    // After a SvelteKit update the style may change; the page would then show a CSP violation.
    const kit = dirname(createRequire(new URL("../package.json", import.meta.url)).resolve("@sveltejs/kit/package.json"));
    const root = readFileSync(join(kit, "src/runtime/components/root.svelte"), "utf8");
    const style = /id="svelte-announcer"[^>]*?style="([^"]*)"/.exec(root)?.[1];
    expect(style, "announcer style in SvelteKit's root.svelte").toBeDefined();
    expect(`sha256-${createHash("sha256").update(style ?? "").digest("base64")}`).toBe(ANNOUNCER_STYLE_HASH);
  });

  it("lets the page reach only the calendars, upgrade hosts, and chain sources the packages use", () => {
    for (const calendar of BROWSER_CALENDARS) {
      expect(DEFAULT_CALENDARS).toContain(calendar);
    }
    expect(UPGRADE_HOSTS).toEqual(DEFAULT_UPGRADE_ALLOWLIST);
    expect(CHAIN_ORIGINS).toEqual(DEFAULT_ESPLORA_URLS.map((url) => new URL(url).origin));
    expect(CSP_DIRECTIVES["connect-src"]).toEqual(["self", ...CONNECT_SOURCES]);
  });

  it("loads nothing from other origins and allows no inline scripts", () => {
    expect(CSP_DIRECTIVES["default-src"]).toEqual(["none"]);
    for (const directive of ["script-src", "worker-src", "font-src", "manifest-src"] as const) {
      expect(CSP_DIRECTIVES[directive], directive).toEqual(["self"]);
    }
    expect(CSP_DIRECTIVES["script-src"]).not.toContain("unsafe-inline");
  });
});
