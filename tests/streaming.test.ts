/**
 * Packages are sealed and verified from sources read in bounded chunks, never whole.
 */
import {
  COMPRESS_MAX_SIZE,
  DocSeal,
  READ_CHUNK_SIZE,
  bytesSource,
  equalBytes,
  hash,
  memorySink,
  readContainer,
  utf8,
  type ByteSource,
} from "@docseal/core";
import { ed25519Suite, generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

/** Deterministic data that deflate cannot shrink much: a hash-seeded xorshift stream. */
function pseudoRandom(length: number, label: string): Uint8Array {
  const out = new Uint8Array(length);
  let x = new DataView(hash(utf8(label)).buffer).getUint32(0) | 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** Wraps a source and records the largest single read. */
function recording(source: ByteSource): ByteSource & { largestRead: number; reads: number } {
  const wrapped = {
    size: source.size,
    largestRead: 0,
    reads: 0,
    read(offset: number, length: number) {
      wrapped.largestRead = Math.max(wrapped.largestRead, length);
      wrapped.reads++;
      return source.read(offset, length);
    },
  };
  return wrapped;
}

const docseal = new DocSeal({ signatures: [ed25519Suite()] });
const signer = memoryKeyProvider(generateSecretKey());

describe("streaming", () => {
  const large = pseudoRandom(COMPRESS_MAX_SIZE + 3 * READ_CHUNK_SIZE + 17, "large");
  const small = utf8("small, compressible ".repeat(100));

  it("seals from sources and verifies a package without reading any document whole", async () => {
    const largeSource = recording(bytesSource(large));
    const sink = memorySink();
    await docseal.sealTo(sink, {
      files: [
        { path: "large.bin", source: largeSource },
        { path: "small.txt", data: small },
      ],
      signer,
      anchor: false,
    });
    // Read twice (hash, then write), in chunks.
    expect(largeSource.largestRead).toBe(READ_CHUNK_SIZE);
    expect(largeSource.reads).toBe(2 * Math.ceil(large.length / READ_CHUNK_SIZE));

    const container = recording(bytesSource(sink.bytes()));
    const report = await docseal.verify(container);
    expect(report.axes.integrity).toBe("valid");
    expect(report.axes.signature).toBe("valid");
    expect(container.largestRead).toBeLessThanOrEqual(READ_CHUNK_SIZE);

    const contents = await readContainer(sink.bytes());
    // toEqual walks large arrays element by element; compare directly.
    expect(equalBytes(contents.files.get("large.bin") ?? new Uint8Array(), large)).toBe(true);
    expect(equalBytes(contents.files.get("small.txt") ?? new Uint8Array(), small)).toBe(true);
  });

  it("stores large documents and deflates small ones", async () => {
    const sink = memorySink();
    await docseal.sealTo(sink, {
      files: [
        { path: "large.bin", data: large },
        { path: "small.txt", data: small },
      ],
      signer,
      anchor: false,
    });
    const zip = sink.bytes();
    // The stored document is in the archive verbatim; the small one is not.
    expect(indexOf(zip, large.subarray(0, 64))).toBeGreaterThan(0);
    expect(indexOf(zip, small.subarray(0, 64))).toBe(-1);
  });

  it.each([
    ["contents", (data: Uint8Array) => data.map((byte, i) => (i === 100 ? byte ^ 1 : byte))],
    ["size", (data: Uint8Array) => data.subarray(0, data.length - 1)],
  ])("refuses to seal a file whose %s change between hashing and writing", async (_, change) => {
    for (const original of [large, small]) {
      let pass = 0;
      let current = original;
      const source: ByteSource = {
        size: original.length,
        read(offset, length) {
          if (offset === 0 && pass++ === 1) {
            current = change(original);
          }
          const bytes = current.subarray(offset, offset + length);
          return bytes.length === length ? Promise.resolve(bytes) : Promise.reject(new Error("file changed while it was being read"));
        },
      };
      await expect(docseal.sealTo(memorySink(), { files: [{ path: "f", source }], signer, anchor: false })).rejects.toThrow(/changed/);
    }
  });

  it("reports a damaged stored document as a format failure", async () => {
    const sealed = await docseal.seal({ files: [{ path: "large.bin", data: large }], signer, anchor: false });
    const zip = sealed.container.slice();
    const at = indexOf(zip, large.subarray(0, 64)) + 5 * READ_CHUNK_SIZE;
    zip[at] = (zip[at] ?? 0) ^ 1;
    const report = await docseal.verify(zip);
    expect(report.axes.format).toBe("invalid");
    expect(report.overall).toBe("invalid");
    expect(report.issues[0]?.message).toMatch(/CRC-32/);
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

describe("pluggable SHA-256", () => {
  it("hashes documents with the configured implementation, after checking it", async () => {
    let updates = 0;
    const counting = () => {
      const h = sha256.create();
      return {
        update(chunk: Uint8Array) {
          updates++;
          h.update(chunk);
        },
        digest: () => h.digest(),
      };
    };
    const custom = new DocSeal({ signatures: [ed25519Suite()], sha256: counting });
    const sealed = await custom.seal({ files: [{ path: "a.txt", data: utf8("a") }], signer, anchor: false });
    expect((await custom.verify(sealed.container)).axes.integrity).toBe("valid");
    expect(updates).toBeGreaterThan(2); // the self-check, sealing, and verifying

    const broken = () => ({ update: () => undefined, digest: () => new Uint8Array(32) });
    expect(() => new DocSeal({ signatures: [ed25519Suite()], sha256: broken })).toThrow(/SHA-256/);
  });
});
