/**
 * Properties of the format's building blocks, checked on generated inputs (fast-check).
 * Each property states something the specification promises for every input, not just the
 * examples in the unit tests. FUZZ_RUNS raises the number of cases (default 100 per property).
 */
import {
  EncodingError,
  FormatError,
  bytesSource,
  checkPathCollisions,
  comparePaths,
  compareBytes,
  crc32,
  fromBase64url,
  fromHex,
  jcs,
  leafHash,
  merkleRoot,
  nodeHash,
  normalizePath,
  openContainer,
  parseJson,
  parseStatement,
  readContainer,
  toBase64url,
  toHex,
  utf8,
  validatePath,
  writeContainer,
  type PackageContents,
} from "@docseal/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const runs = Number(process.env.FUZZ_RUNS ?? 100);
const options = { numRuns: runs };

/** Whether `f` succeeds, fails with `errorType`, or throws something else (a bug). */
function outcome<T>(f: () => T, errorType: new (...args: never[]) => Error): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    if (error instanceof errorType) {
      return { ok: false };
    }
    throw error;
  }
}

describe("JSON and JCS", () => {
  it("JCS is idempotent and independent of key order", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const canonical = jcs(value);
        expect(jcs(parseJson(canonical))).toEqual(canonical);
        const reordered = JSON.parse(JSON.stringify(value), (_, v: unknown) =>
          v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v,
        ) as unknown;
        expect(jcs(reordered)).toEqual(canonical);
      }),
      options,
    );
  });

  it("any repeated key is rejected, wherever it is", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue(), { minKeys: 1 }), fc.nat(), (object, pick) => {
        const keys = Object.keys(object);
        const key = keys[pick % keys.length] ?? "";
        const body = JSON.stringify(object).slice(1, -1);
        const text = `{${body},${JSON.stringify(key)}:null}`;
        expect(() => parseJson(utf8(text))).toThrow(FormatError);
      }),
      options,
    );
  });
});

describe("encodings", () => {
  it("hex and base64url round-trip", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        expect(fromHex(toHex(bytes))).toEqual(bytes);
        expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
      }),
      options,
    );
  });

  it("decoding is canonical: a string that decodes is the only encoding of its bytes", () => {
    const alphabet = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/ ");
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 40 }).map((a) => a.join("")), (text) => {
        const decoded = outcome(() => fromBase64url(text), EncodingError);
        if (decoded.ok) {
          expect(toBase64url(decoded.value)).toBe(text);
        }
      }),
      options,
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...Array.from("0123456789abcdefABCDEFg ")), { maxLength: 40 }).map((a) => a.join("")), (text) => {
        const decoded = outcome(() => fromHex(text), EncodingError);
        if (decoded.ok) {
          expect(toHex(decoded.value)).toBe(text);
        }
      }),
      options,
    );
  });
});

/** Path-like strings: mostly ASCII, with separators, dots, and some Unicode that normalizes. */
const pathLike = fc
  .array(fc.constantFrom(...Array.from("aAbB.-_ /\\é\u0301ßΣσς\u0000\u007fЖж")), { minLength: 1, maxLength: 24 })
  .map((chars) => chars.join(""));

describe("paths", () => {
  it("normalizePath either rejects or yields a valid, stable NFC path", () => {
    fc.assert(
      fc.property(fc.oneof(pathLike, fc.string()), (raw) => {
        const result = outcome(() => normalizePath(raw), FormatError);
        if (result.ok) {
          const path = result.value;
          expect(path).toBe(path.normalize("NFC"));
          expect(normalizePath(path)).toBe(path);
          expect(() => {
            validatePath(path);
          }).not.toThrow();
          expect(path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")).toBe(true);
          // eslint-disable-next-line no-control-regex -- control characters are what must be absent
          expect(/[\u0000-\u001f\u007f\\]/.test(path)).toBe(false);
        }
      }),
      options,
    );
  });

  it("comparePaths orders by UTF-8 bytes", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.string({ unit: "grapheme" }), (a, b) => {
        expect(Math.sign(comparePaths(a, b))).toBe(Math.sign(compareBytes(utf8(a), utf8(b))));
      }),
      options,
    );
  });

  it("paths equal under lowercasing or uppercasing collide, as do a path and its parent", () => {
    fc.assert(
      fc.property(pathLike, (raw) => {
        const path = outcome(() => normalizePath(raw), FormatError);
        if (!path.ok) return;
        for (const variant of [path.value.toLowerCase(), path.value.toUpperCase()]) {
          const other = outcome(() => normalizePath(variant), FormatError);
          if (other.ok && other.value !== path.value) {
            expect(() => {
              checkPathCollisions([path.value, other.value]);
            }).toThrow(FormatError);
          }
        }
        const child = outcome(() => normalizePath(`${path.value}/child`), FormatError);
        if (child.ok) {
          expect(() => {
            checkPathCollisions([path.value, child.value]);
          }).toThrow(FormatError);
        }
      }),
      options,
    );
  });
});

describe("Merkle tree", () => {
  /** RFC 6962 §2.1, written independently of the implementation. */
  function reference(leaves: Uint8Array[]): Uint8Array {
    if (leaves.length === 1) return leaves[0] ?? new Uint8Array();
    let k = 1;
    while (k * 2 < leaves.length) k *= 2;
    return nodeHash(reference(leaves.slice(0, k)), reference(leaves.slice(k)));
  }

  const leaf = fc
    .record({ path: fc.string({ minLength: 1 }), size: fc.nat(), hash: fc.uint8Array({ minLength: 32, maxLength: 32 }), salt: fc.uint8Array({ minLength: 16, maxLength: 16 }) })
    .map((e) => leafHash({ path: e.path, size: e.size, hash: toHex(e.hash), salt: toHex(e.salt) }));

  it("matches the RFC 6962 definition for any number of leaves", () => {
    fc.assert(
      fc.property(fc.array(leaf, { minLength: 1, maxLength: 70 }), (leaves) => {
        expect(merkleRoot(leaves)).toEqual(reference(leaves));
      }),
      options,
    );
  });

  it("changes when any leaf changes, is added, or is removed", () => {
    fc.assert(
      fc.property(fc.array(leaf, { minLength: 2, maxLength: 20 }), fc.nat(), leaf, (leaves, at, other) => {
        const root = toHex(merkleRoot(leaves));
        const i = at % leaves.length;
        fc.pre(toHex(other) !== toHex(leaves[i] ?? new Uint8Array()));
        expect(toHex(merkleRoot(leaves.map((l, j) => (j === i ? other : l))))).not.toBe(root);
        expect(toHex(merkleRoot([...leaves, other]))).not.toBe(root);
        expect(toHex(merkleRoot(leaves.filter((_, j) => j !== i)))).not.toBe(root);
      }),
      options,
    );
  });

  it("a leaf never equals an inner node over the same bytes (domain separation)", () => {
    fc.assert(
      fc.property(leaf, leaf, (a, b) => {
        expect(toHex(nodeHash(a, b))).not.toBe(toHex(a));
        expect(toHex(merkleRoot([a, b]))).toBe(toHex(nodeHash(a, b)));
      }),
      options,
    );
  });
});

describe("CRC-32", () => {
  it("continues across any split", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), fc.nat(), (data, at) => {
        const split = at % (data.length + 1);
        expect(crc32(data.subarray(split), crc32(data.subarray(0, split)))).toBe(crc32(data));
      }),
      options,
    );
  });
});

describe("timestamps", () => {
  const statement = (createdAt: string) => ({
    type: "docseal-package-statement",
    version: 1,
    packageId: "urn:uuid:00000000-0000-4000-8000-000000000000",
    hashAlgorithm: "sha-256",
    merkleScheme: "docseal-v1",
    merkleRoot: "00".repeat(32),
    manifestHash: "00".repeat(32),
    createdAt,
    previous: null,
    signaturePolicy: { type: "any-valid" },
    critical: [],
  });

  /** Independent reference: the fields must survive a round trip through a UTC date. */
  function isRealTimestamp(text: string): boolean {
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?Z$/.exec(text);
    if (!m) return false;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const date = new Date(0);
    date.setUTCFullYear(y, mo - 1, d);
    date.setUTCHours(h, mi, s);
    return (
      date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d &&
      date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s
    );
  }

  const twoDigits = fc.integer({ min: 0, max: 99 }).map((n) => String(n).padStart(2, "0"));
  const candidate = fc
    .tuple(fc.integer({ min: 0, max: 9999 }), twoDigits, twoDigits, twoDigits, twoDigits, twoDigits, fc.constantFrom("", ".5", ".123456"), fc.constantFrom("Z", "Z", "Z", "+00:00", "z"))
    .map(([y, mo, d, h, mi, s, frac, zone]) => `${String(y).padStart(4, "0")}-${mo}-${d}T${h}:${mi}:${s}${frac}${zone}`);

  it("are accepted exactly when they name a real UTC date and time", () => {
    fc.assert(
      fc.property(fc.oneof(candidate, fc.date({ noInvalidDate: true, min: new Date("0000-01-01T00:00:00Z"), max: new Date("9999-12-31T23:59:59Z") }).map((d) => d.toISOString())), (text) => {
        const accepted = outcome(() => parseStatement(statement(text)), FormatError).ok;
        expect(accepted, text).toBe(isRealTimestamp(text));
      }),
      { numRuns: runs * 5 },
    );
  });
});

describe("container", () => {
  const segment = fc.stringMatching(/^[A-Za-z0-9_-][A-Za-z0-9_. -]{0,11}$/).filter((s) => s !== "." && s !== ".." && !s.endsWith(" "));
  const contentsArb = fc
    .uniqueArray(fc.array(segment, { minLength: 1, maxLength: 3 }).map((segments) => segments.join("/")), {
      minLength: 1,
      maxLength: 8,
      selector: (path) => path.toLowerCase(),
    })
    .filter(
      (paths) =>
        outcome(() => {
          checkPathCollisions(paths);
        }, FormatError).ok,
    )
    .chain((paths) =>
      fc.tuple(
        fc.constant(paths),
        fc.array(fc.oneof(fc.uint8Array({ maxLength: 3000 }), fc.constant(new Uint8Array(5000).fill(65))), { minLength: paths.length, maxLength: paths.length }),
        fc.boolean(),
      ),
    )
    .map(([paths, data, zip64]): [PackageContents, boolean] => [
      {
        manifest: utf8("{}"),
        statement: utf8("{}"),
        files: new Map(paths.map((path, i) => [path, data[i] ?? new Uint8Array()])),
        signatures: new Map([["signatures/0001.json", utf8("{}")]]),
        anchors: new Map(),
      },
      zip64,
    ]);

  it("round-trips any contents, with or without ZIP64 fields", { timeout: 120_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(contentsArb, async ([contents, forceZip64]) => {
        const zip = await writeContainer(contents, { forceZip64 });
        const read = await readContainer(zip);
        expect([...read.files.keys()]).toEqual([...contents.files.keys()]);
        for (const [path, data] of contents.files) {
          expect(toHex(read.files.get(path) ?? new Uint8Array([1]))).toBe(toHex(data));
        }
        const opened = await openContainer(bytesSource(zip));
        expect([...opened.files.values()].map((f) => f.size)).toEqual([...contents.files.values()].map((d) => d.length));
      }),
      { numRuns: Math.max(10, Math.ceil(runs / 4)) },
    );
  });
});
