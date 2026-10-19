import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { CSP_DIRECTIVES } from "./csp.js";

const source = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig({
  plugins: [
    sveltekit({
      // Every page is prerendered to static files; there is no server.
      adapter: adapter({ strict: true }),
      // GitHub Pages serves the project under /<repository>; set by the deploy workflow.
      paths: { base: (process.env.BASE_PATH ?? "") as "" | `/${string}` },
      // See csp.js: a <meta> policy with hashes, since GitHub Pages cannot send headers.
      csp: { mode: "hash", directives: CSP_DIRECTIVES },
    }),
  ],
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
