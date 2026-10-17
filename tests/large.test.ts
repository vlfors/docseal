/**
 * A real package larger than 4 GiB: ZIP64 sizes and offsets, sealed and verified through
 * files on disk with bounded memory. Slow (about two minutes), so only run on request:
 *
 *   DOCSEAL_LARGE_TESTS=1 pnpm vitest run tests/large.test.ts
 */
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocSeal, type ByteSource } from "@docseal/core";
import { ed25519Suite, generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";
import { describe, expect, it } from "vitest";

const SIZE = 2 ** 32 + 1024 * 1024 + 3;

/** SIZE bytes of a repeating pattern, generated on demand. */
const pattern: ByteSource = {
  size: SIZE,
  read(offset, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = (offset + i) % 251;
    }
    return Promise.resolve(out);
  },
};

const nodeSha256 = () => {
  const h = createHash("sha256");
  return {
    update(chunk: Uint8Array) {
      h.update(chunk);
    },
    digest: () => new Uint8Array(h.digest()),
  };
};

describe.skipIf(process.env.DOCSEAL_LARGE_TESTS !== "1")("larger than 4 GiB", () => {
  it("seals to a file and verifies from it", { timeout: 15 * 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "docseal-large-"));
    try {
      const path = join(dir, "large.dseal");
      const docseal = new DocSeal({ signatures: [ed25519Suite()], sha256: nodeSha256 });
      const out = await open(path, "w");
      try {
        await docseal.sealTo(
          {
            async write(chunk) {
              await out.write(chunk);
            },
          },
          { files: [{ path: "large.bin", source: pattern }, { path: "small.txt", data: new Uint8Array([1, 2, 3]) }], signer: memoryKeyProvider(generateSecretKey()), anchor: false },
        );
      } finally {
        await out.close();
      }

      const file = await open(path, "r");
      try {
        const { size } = await file.stat();
        expect(size).toBeGreaterThan(SIZE);
        const source: ByteSource = {
          size,
          async read(offset, length) {
            const buffer = new Uint8Array(length);
            const { bytesRead } = await file.read(buffer, 0, length, offset);
            expect(bytesRead).toBe(length);
            return buffer;
          },
        };
        const report = await docseal.verify(source);
        expect(report.axes).toMatchObject({ format: "valid", integrity: "valid", signature: "valid" });
        expect(process.memoryUsage().rss).toBeLessThan(1024 ** 3);
      } finally {
        await file.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
