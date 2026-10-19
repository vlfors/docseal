/**
 * Global setup for DOCSEAL_LARGE_TESTS=1: seals a 2 GiB package in Node.js to the path that
 * vitest.browser.config.ts provides as `largePackage`, so a browser test can open it as a real
 * File from disk. (A Blob of that size built in the page cannot be read back in Chromium: it
 * fails with NotReadableError.)
 */
import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { sealPackageTo, type ByteSource } from "@docseal/core";
import { generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    largePackage: string;
  }
}

export const LARGE_SIZE = 2 * 1024 ** 3;

/** LARGE_SIZE bytes of a repeating pattern, generated on demand. */
const pattern: ByteSource = {
  size: LARGE_SIZE,
  read(offset, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = (offset + i) % 251;
    }
    return Promise.resolve(out);
  },
};

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  const path = project.config.provide.largePackage;
  if (!path) {
    return undefined;
  }
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const out = await open(path, "w");
  try {
    await sealPackageTo(
      {
        async write(chunk) {
          await out.write(chunk);
        },
      },
      {
        files: [{ path: "large.bin", source: pattern }],
        signer: memoryKeyProvider(generateSecretKey()),
        sha256: () => {
          const h = createHash("sha256");
          return {
            update(chunk: Uint8Array) {
              h.update(chunk);
            },
            digest: () => new Uint8Array(h.digest()),
          };
        },
      },
    );
  } finally {
    await out.close();
  }
  return () => rm(dir, { recursive: true, force: true });
}
