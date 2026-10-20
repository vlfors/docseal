/**
 * How large a package each engine can build in memory: the path of Firefox and Safari, where
 * the worker collects the package's chunks and hands back one Blob (apps/web/src/lib/output.ts).
 * A size passes when the Blob is built and both of its ends can be read back. Only with
 * DOCSEAL_MEMORY_PROBE=1 (minutes, and gigabytes of memory):
 *
 *   DOCSEAL_MEMORY_PROBE=1 pnpm test:browser tests/browser/memory
 */
import { MEDIA_TYPE, READ_CHUNK_SIZE } from "@docseal/core";
import { describe, expect, inject, it } from "vitest";

declare module "vitest" {
  interface ProvidedContext {
    memoryProbe: boolean;
  }
}

const MiB = 1024 * 1024;
const SIZES = [512, 1024, 1536, 2048, 3072].map((n) => n * MiB);

/** Builds a Blob of `size` bytes from 1 MiB chunks, as the worker's memory output does. */
async function buildAndReadBack(size: number): Promise<string> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < size; offset += READ_CHUNK_SIZE) {
    const chunk = new Uint8Array(Math.min(READ_CHUNK_SIZE, size - offset));
    chunk[0] = (offset / READ_CHUNK_SIZE) % 251;
    chunks.push(chunk);
  }
  const blob = new Blob(chunks, { type: MEDIA_TYPE });
  chunks.length = 0;
  const first = new Uint8Array(await blob.slice(0, 1).arrayBuffer());
  const last = new Uint8Array(await blob.slice(size - READ_CHUNK_SIZE, size - READ_CHUNK_SIZE + 1).arrayBuffer());
  expect(first[0]).toBe(0);
  return `last chunk marker ${String(last[0])}`;
}

describe.runIf(inject("memoryProbe"))("building a package in memory", () => {
  it.each(SIZES)("%i bytes", { timeout: 600_000 }, async (size) => {
    const start = performance.now();
    let outcome: string;
    try {
      outcome = `ok (${await buildAndReadBack(size)})`;
    } catch (error) {
      outcome = `failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
    console.log(`${String(size / MiB)} MiB in memory: ${outcome}, ${((performance.now() - start) / 1000).toFixed(1)} s`);
  });
});
