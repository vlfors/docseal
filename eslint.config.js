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
          allowDefaultProject: ["*.js", "*.ts"],
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
    files: ["examples/*.mjs", "scripts/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } },
  },
  // The browser app. The recommended Svelte rules include svelte/no-at-html-tags: package text is
  // never rendered as markup.
  ...svelte.configs.recommended,
  {
    files: ["apps/web/**/*.svelte", "apps/web/**/*.svelte.ts"],
    languageOptions: {
      globals: globals.browser,
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
