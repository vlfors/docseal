/**
 * The golden packages in real browser engines: each must get the verdicts that
 * spec/vectors/packages/expected.json requires, read from memory and from a Blob, and whether
 * or not the engine's DecompressionStream rejects bytes after the end of a deflate stream.
 */
import { blobSource, bytesSource, hashStream, toHex, verifyPackage, type ByteSource } from "@docseal/core";
import { openTimestamps } from "@docseal/anchor-ots";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { inflateSync } from "fflate";
import { afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { platformRejectsTrailingData } from "../../packages/core/src/zip.js";
import expected from "../../spec/vectors/packages/expected.json";

declare module "vitest" {
  interface ProvidedContext {
    goldenPackages: string[];
    benchmark: boolean;
  }
}

const packages = new Map<string, Uint8Array>();

beforeAll(async () => {
  for (const file of inject("goldenPackages")) {
    const response = await fetch(new URL(`../../spec/vectors/packages/${file}`, import.meta.url));
    expect(response.ok, file).toBe(true);
    packages.set(file, new Uint8Array(await response.arrayBuffer()));
  }
});

/** The configuration every verifier uses for golden packages: offline, no trust policy. */
async function verifyOffline(input: Uint8Array | ByteSource) {
  const report = await verifyPackage(input, { suites: [ed25519Suite()], anchors: [openTimestamps()] });
  return { axes: report.axes, overall: report.overall };
}

function bytesOf(file: string): Uint8Array {
  const bytes = packages.get(file);
  if (!bytes) {
    throw new Error(`${file} is listed in expected.json but missing`);
  }
  return bytes;
}

describe("golden packages", () => {
  it("are all listed in expected.json", () => {
    expect([...packages.keys()].sort()).toEqual(expected.packages.map((entry) => entry.file).sort());
  });

  it.each(expected.packages)("$file", async ({ file, expected: verdict }) => {
    const bytes = bytesOf(file);
    expect(await verifyOffline(bytes)).toEqual(verdict);
    expect(await verifyOffline(blobSource(new Blob([bytes as Uint8Array<ArrayBuffer>])))).toEqual(verdict);
  });
});

describe("deflate data after the end of the stream", () => {
  it("is detected on this engine", async () => {
    const rejects = await platformRejectsTrailingData();
    console.log(`DecompressionStream rejects trailing bytes: ${String(rejects)}`);
    expect(typeof rejects).toBe("boolean");
  });

  // An engine that ignores trailing bytes goes through the fallback check; the verdicts must
  // be the same as on an engine that rejects them.
  describe("on an engine that ignores it", () => {
    class IgnoresTrailingData extends TransformStream<Uint8Array, Uint8Array> {
      constructor() {
        const chunks: number[] = [];
        super({
          transform: (chunk) => {
            chunks.push(...chunk);
          },
          flush: (controller) => {
            controller.enqueue(inflateSync(new Uint8Array(chunks)));
          },
        });
      }
    }
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("gives the same verdicts", async () => {
      vi.stubGlobal("DecompressionStream", IgnoresTrailingData);
      expect(await platformRejectsTrailingData()).toBe(false);
      for (const { file, expected: verdict } of expected.packages) {
        expect(await verifyOffline(bytesSource(bytesOf(file))), file).toEqual(verdict);
      }
    });
  });
});

describe.runIf(inject("benchmark"))("streaming SHA-256", () => {
  it("hashes 1 GiB from a Blob", { timeout: 600_000 }, async () => {
    const chunk = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
    const blob = new Blob(Array.from({ length: 1024 }, () => chunk));
    async function* chunks() {
      for (let offset = 0; offset < blob.size; offset += chunk.length) {
        yield new Uint8Array(await blob.slice(offset, offset + chunk.length).arrayBuffer());
      }
    }
    const start = performance.now();
    const { digest, size } = await hashStream(chunks());
    const seconds = (performance.now() - start) / 1000;
    console.log(`SHA-256 of 1 GiB: ${seconds.toFixed(1)} s, ${(1024 / seconds).toFixed(0)} MiB/s`);
    expect(size).toBe(blob.size);
    expect(toHex(digest)).toHaveLength(64);
  });
});
