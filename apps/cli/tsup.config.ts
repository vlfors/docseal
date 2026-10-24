import { defineConfig } from "tsup";

/**
 * The CLI is bundled with the DocSeal packages it uses (devDependencies, so tsup bundles
 * them), and lists their third-party dependencies as its own: the release tarball installs on
 * its own from a URL, without @docseal/* on npm. tests/release.test.ts keeps the lists in step.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  clean: true,
  sourcemap: true,
  // Bundled from source, as the tests run it: no separate build of each package first.
  esbuildOptions(options) {
    options.conditions = ["development"];
  },
});
