import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { CSP_DIRECTIVES } from "./csp.js";

const source = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

const BASE_PATH = process.env.BASE_PATH ?? "";
// A preview is served one folder below the release it sits beside (/docseal/preview beside /docseal/).
const RELEASE = process.env.DOCSEAL_RELEASE ? { version: process.env.DOCSEAL_RELEASE, path: BASE_PATH.replace(/\/[^/]*$/, "/") } : null;

export default defineConfig({
  plugins: [
    sveltekit({
      // Every page is prerendered to static files; there is no server.
      adapter: adapter({ strict: true }),
      // GitHub Pages serves the project under /<repository>; set by the deploy workflow.
      paths: { base: BASE_PATH as "" | `/${string}` },
      // See csp.js: a <meta> policy with hashes, since GitHub Pages cannot send headers.
      csp: { mode: "hash", directives: CSP_DIRECTIVES },
      // A preview links to its release, which is another site outside the base path: not crawled.
      prerender: {
        handleHttpError: ({ path, message }) => {
          if (RELEASE !== null && path === RELEASE.path) {
            return;
          }
          throw new Error(message);
        },
      },
    }),
  ],
  // The commit the release workflow builds from, shown on every page so a viewer can tell which
  // code is running; a local build shows that it is one.
  // A release names its version; a preview (.github/workflows/preview.yml) says on every page
  // that it is not a release, and links to the release served beside it.
  define: {
    __DOCSEAL_COMMIT__: JSON.stringify(process.env.DOCSEAL_COMMIT ?? ""),
    __DOCSEAL_PREVIEW__: JSON.stringify(process.env.DOCSEAL_PREVIEW === "1"),
    __DOCSEAL_VERSION__: JSON.stringify(process.env.DOCSEAL_VERSION ?? ""),
    __DOCSEAL_RELEASE__: JSON.stringify(RELEASE),
  },
  // Workers are started as module workers (`{ type: "module" }`), so they are built as modules too.
  worker: { format: "es" },
  resolve: {
    // The workspace packages are built from their sources, in development and in production
    // builds alike, so the site never depends on stale dist/ output. (Not via the "development"
    // condition: that would also switch Svelte itself into development mode in production.)
    alias: {
      "@docseal/core": source("core/src/index.ts"),
      "@docseal/sig-ed25519": source("sig-ed25519/src/index.ts"),
      "@docseal/anchor-ots": source("anchor-ots/src/index.ts"),
    },
  },
});
