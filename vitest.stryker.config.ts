import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Mutation testing (Stryker's command runner, which switches a mutant on through the
 * __STRYKER_ACTIVE_MUTANT__ environment variable) runs the suite once per mutant: leave out
 * the slow, process-spawning tests.
 * Stryker mutates a copy of the sources in a sandbox, while the workspace packages resolve
 * through node_modules to the originals; the aliases point them at the mutated copies.
 */
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        "@docseal/core": source("./packages/core/src/index.ts"),
        "@docseal/sig-ed25519": source("./packages/sig-ed25519/src/index.ts"),
        "@docseal/anchor-ots": source("./packages/anchor-ots/src/index.ts"),
      },
    },
    test: {
      exclude: ["tests/differential.test.ts", "tests/large.test.ts", "**/node_modules/**"],
      env: { FUZZ_RUNS: "50" },
      // Instrumented code is several times slower; the streaming tests hash megabytes.
      testTimeout: 60_000,
    },
  }),
);
