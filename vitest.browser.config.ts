import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The core in real browser engines: Chromium, Firefox, and WebKit through Playwright.
 *
 *   pnpm exec playwright install chromium firefox webkit
 *   pnpm test:browser
 *
 * DOCSEAL_BENCHMARK=1 also hashes 1 GiB in each engine and prints the speed.
 */
export default defineConfig({
  resolve: {
    // The workspace packages from their sources, as the web app uses them.
    alias: {
      "@docseal/core": source("./packages/core/src/index.ts"),
      "@docseal/sig-ed25519": source("./packages/sig-ed25519/src/index.ts"),
      "@docseal/anchor-ots": source("./packages/anchor-ots/src/index.ts"),
    },
  },
  test: {
    include: ["tests/browser/**/*.browser.test.ts"],
    provide: {
      // The page cannot list a directory: the test is told which golden packages exist.
      goldenPackages: readdirSync(source("./spec/vectors/packages")).filter((name) => name.endsWith(".dseal")),
      benchmark: process.env.DOCSEAL_BENCHMARK === "1",
    },
    testTimeout: 60_000,
    // The tests print what they measure in each engine.
    silent: false,
    browser: {
      enabled: true,
      headless: true,
      // There is no page to look at: the tests drive the core, not a user interface.
      screenshotFailures: false,
      provider: playwright(),
      instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
    },
  },
});
