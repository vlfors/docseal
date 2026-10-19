/**
 * Verification in a real Web Worker: the page stays responsive while a large package is
 * hashed, progress arrives, and cancelling stops the work. DOCSEAL_LARGE_TESTS=1 uses a
 * 2 GiB package on disk (tests/browser/large-package.ts) instead of 64 MiB built in memory.
 */
import { READ_CHUNK_SIZE, memorySink, sealPackageTo, type ByteSource } from "@docseal/core";
import { memoryKeyProvider } from "@docseal/sig-ed25519";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { userEvent } from "vitest/browser";
import { VerificationCancelled, verifyInWorker } from "./client";

declare module "vitest" {
  interface ProvidedContext {
    largePackage: string;
  }
}

const MiB = 1024 * 1024;

/** `size` bytes of a repeating pattern, generated on demand. */
function pattern(size: number): ByteSource {
  const period = 251;
  const block = new Uint8Array(READ_CHUNK_SIZE + period).map((_, i) => i % period);
  return {
    size,
    read(offset, length) {
      const start = offset % period;
      return Promise.resolve(length <= READ_CHUNK_SIZE ? block.slice(start, start + length) : new Uint8Array(length).map((_, i) => (offset + i) % period));
    },
  };
}

let large: Blob;

beforeAll(async () => {
  const path = inject("largePackage");
  if (path) {
    // A real File from disk, as a user would choose it.
    const input = document.createElement("input");
    input.type = "file";
    document.body.append(input);
    await userEvent.upload(input, path);
    const file = input.files?.[0];
    input.remove();
    if (!file) {
      throw new Error(`could not open ${path}`);
    }
    large = file;
    return;
  }
  const sink = memorySink();
  await sealPackageTo(sink, {
    files: [{ path: "large.bin", source: pattern(64 * MiB) }],
    signer: memoryKeyProvider(new Uint8Array(32).fill(7)),
  });
  large = new Blob([sink.bytes() as Uint8Array<ArrayBuffer>]);
});

describe("verifyInWorker", () => {
  it("verifies a golden package and returns its report", async () => {
    const response = await fetch(new URL("../../../../../spec/vectors/packages/valid-basic.dseal", import.meta.url));
    const report = await verifyInWorker(await response.blob()).result;
    expect(report.axes.integrity).toBe("valid");
    expect(report.axes.signature).toBe("valid");
    expect(report.files.map((file) => file.status)).toEqual(["valid", "valid", "valid"]);
  });

  it("keeps the page responsive and reports progress", { timeout: 900_000 }, async () => {
    // A timer on the page: each tick that comes late shows the page's thread was busy. On the
    // page's own thread the core yields between chunks, so no single pause is long; the share of
    // time lost to late ticks while hashing is what tells the two apart: 36-48 % there in
    // Chromium and Firefox, 0 % here. (WebKit hashes a chunk in about 16 ms, so its page stays
    // responsive either way.) It is counted from the first progress message: starting the worker
    // is a single pause of up to about 120 ms (WebKit, loading its modules from the dev server).
    const PERIOD = 10;
    let busy = 0;
    let longestGap = 0;
    let last = performance.now();
    let hashingSince: number | undefined;
    const timer = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      if (hashingSince !== undefined) {
        // Ticks a little late are timer jitter (WebKit delivers each about 2 ms late); a tick a
        // whole period late means the thread was taken.
        busy += Math.max(0, now - last - 2 * PERIOD);
      }
      last = now;
    }, PERIOD);
    const progress: number[] = [];
    try {
      const report = await verifyInWorker(large, {
        onProgress: (read) => {
          hashingSince ??= performance.now();
          progress.push(read);
        },
      }).result;
      expect(report.axes.integrity).toBe("valid");
    } finally {
      clearInterval(timer);
    }
    const share = busy / (performance.now() - (hashingSince ?? 0));
    console.log(
      `${(large.size / MiB).toFixed(0)} MiB in a worker: page busy ${(share * 100).toFixed(0)} % of the time while hashing, longest pause ${longestGap.toFixed(0)} ms, ${String(progress.length)} progress messages`,
    );
    expect(share).toBeLessThan(0.1);
    expect(longestGap).toBeLessThan(250);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBeLessThanOrEqual(large.size);
  });

  it("stops at once when cancelled", async () => {
    let afterCancel = 0;
    let cancelled = false;
    const task = verifyInWorker(large, {
      onProgress: () => {
        if (cancelled) {
          afterCancel++;
        } else {
          cancelled = true;
          task.cancel();
        }
      },
    });
    await expect(task.result).rejects.toBeInstanceOf(VerificationCancelled);
    // A worker that kept running would go on posting progress.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(afterCancel).toBe(0);
  });

  it("reports a file that is not a package as invalid", async () => {
    const report = await verifyInWorker(new Blob(["not a package"])).result;
    expect(report.axes.format).toBe("invalid");
    expect(report.overall).toBe("invalid");
  });
});
