import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", ".stryker-tmp/**", "reports/**", "apps/web/.svelte-kit/**", "apps/web/build/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.ts", "apps/mcp/tsup.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["tests/mcp/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["examples/*.mjs", "scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } },
  },
  // The browser app. The recommended Svelte rules include svelte/no-at-html-tags: package text is
  // never rendered as markup.
  ...svelte.configs.recommended,
  {
    files: ["apps/web/**/*.svelte", "apps/web/**/*.svelte.ts"],
    languageOptions: {
      // The __DOCSEAL_*__ constants are defined at build time (apps/web/vite.config.ts).
      globals: { ...globals.browser, __DOCSEAL_COMMIT__: "readonly", __DOCSEAL_PREVIEW__: "readonly", __DOCSEAL_VERSION__: "readonly", __DOCSEAL_RELEASE__: "readonly" },
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".svelte"],
      },
    },
  },
  {
    files: ["apps/web/*.js", "apps/web/*.ts"],
    languageOptions: { globals: globals.node },
  },
);
