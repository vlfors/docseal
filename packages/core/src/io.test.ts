import { describe, expect, it } from "vitest";
import { blobSource, bytesSource, memorySink, readAll, readChunks } from "./io.js";

const data = new Uint8Array([1, 2, 3, 4, 5]);

describe.each([
  ["bytesSource", () => bytesSource(data)],
  ["blobSource", () => blobSource(new Blob([data]))],
])("%s", (_name, source) => {
  it("reads exactly the requested range", async () => {
    expect(source().size).toBe(5);
    expect(await source().read(1, 3)).toEqual(new Uint8Array([2, 3, 4]));
    expect(await source().read(0, 5)).toEqual(data);
    expect(await source().read(5, 0)).toEqual(new Uint8Array());
  });

  it.each([
    [-1, 1],
    [0, 6],
    [4, 2],
    [5, 1],
  ])("rejects a read at %i of %i bytes, outside the data", async (offset, length) => {
    await expect(source().read(offset, length)).rejects.toThrow(new RangeError("Read past the end of the data"));
  });
});

describe("bytesSource", () => {
  it("rejects a negative length, and an empty read past the end", async () => {
    await expect(bytesSource(data).read(2, -1)).rejects.toThrow(RangeError);
    await expect(bytesSource(data).read(6, 0)).rejects.toThrow(RangeError);
  });
});

describe("memorySink", () => {
  it("keeps a copy of each chunk, so callers may reuse their buffers", async () => {
    const sink = memorySink();
    const buffer = new Uint8Array([1, 2]);
    await sink.write(buffer);
    buffer.fill(9);
    await sink.write(buffer);
    expect(sink.bytes()).toEqual(new Uint8Array([1, 2, 9, 9]));
  });
});

describe("readChunks", () => {
  it("splits a range into chunks of at most the given size", async () => {
    const chunks: number[][] = [];
    for await (const chunk of readChunks(bytesSource(data), 1, 4, 3)) chunks.push([...chunk]);
    expect(chunks).toEqual([[2, 3, 4], [5]]);
  });

  it("rejects a source that returns fewer bytes than asked for", async () => {
    const short = { size: 5, read: () => Promise.resolve(new Uint8Array(1)) };
    await expect(readAll({ size: 0, read: () => Promise.reject(new Error("not called")) })).resolves.toEqual(new Uint8Array());
    const drain = async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of readChunks(short)) chunks.push(chunk);
      return chunks;
    };
    await expect(drain()).rejects.toThrow("Short read: expected 5 bytes, got 1");
  });
});
