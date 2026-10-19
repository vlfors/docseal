import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** With DOCSEAL_LARGE_TESTS=1, the global setup writes a 2 GiB package here. */
const largeDir = process.env.DOCSEAL_LARGE_TESTS === "1" ? join(tmpdir(), "docseal-browser-large") : undefined;

/**
 * The core in real browser engines: Chromium, Firefox, and WebKit through Playwright.
 *
 *   pnpm exec playwright install chromium firefox webkit
 *   pnpm test:browser
 *
 * DOCSEAL_BENCHMARK=1 also hashes 1 GiB in each engine and prints the speed; DOCSEAL_LARGE_TESTS=1
 * verifies a 2 GiB package in a worker instead of 64 MiB.
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
  // The browser opens the large package as a file through the dev server, outside the project.
  ...(largeDir && { server: { fs: { allow: [source("."), largeDir] } } }),
  test: {
    include: ["tests/browser/**/*.browser.test.ts", "apps/web/src/**/*.browser.test.ts"],
    provide: {
      // The page cannot list a directory: the test is told which golden packages exist.
      goldenPackages: readdirSync(source("./spec/vectors/packages")).filter((name) => name.endsWith(".dseal")),
      benchmark: process.env.DOCSEAL_BENCHMARK === "1",
      largePackage: largeDir ? join(largeDir, "large.dseal") : "",
    },
    globalSetup: ["tests/browser/large-package.ts", "tests/browser/sealed-reference.ts"],
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
