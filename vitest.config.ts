import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    // Run in real browser engines: vitest.browser.config.ts.
    exclude: [...configDefaults.exclude, "tests/browser/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      // The roadmap's floor for v0.1; the suite is well above it (about 97 % of lines).
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});
