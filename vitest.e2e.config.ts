import { defineConfig } from "vitest/config";

/**
 * End-to-end tests of the built site in real browsers (Playwright, driven from Node.js).
 *
 *   pnpm test:e2e            # builds apps/web, then runs tests/e2e/
 */
export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    globalSetup: ["tests/e2e/server.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The tests print what they measure in each engine.
    silent: false,
    // One file at a time: each launches its browsers, and hashing in several at once on a small
    // CI machine makes waits time out.
    fileParallelism: false,
  },
});
