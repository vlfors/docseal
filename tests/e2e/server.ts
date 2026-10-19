/**
 * Global setup of the end-to-end tests: serves the built site (apps/web/build) the way GitHub
 * Pages does, as static files with no headers of our own, so the page's <meta> CSP is all the
 * policy there is.
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    siteUrl: string;
  }
}

const ROOT = fileURLToPath(new URL("../../apps/web/build/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  try {
    await stat(join(ROOT, "index.html"));
  } catch {
    throw new Error("Build the site first: pnpm --filter @docseal/web build");
  }
  const server = createServer((request, response) => {
    void (async () => {
      const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
      let file = join(ROOT, path);
      if (!file.startsWith(ROOT)) {
        response.writeHead(403).end();
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) {
          file = join(file, "index.html");
        }
        const body = await readFile(file);
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  project.provide("siteUrl", `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`);
  return () =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
}
