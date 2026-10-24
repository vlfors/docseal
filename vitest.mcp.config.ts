import { defineConfig } from "vitest/config";

/**
 * End-to-end tests of the built MCP server: each starts apps/mcp/dist/index.js over stdio, as a
 * client would, with the fake network preloaded (tests/mcp/fake-network.mjs).
 *
 *   pnpm test:mcp            # builds @docseal/mcp and what it needs, then runs tests/mcp/
 */
export default defineConfig({
  test: {
    include: ["tests/mcp/**/*.mcp.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
