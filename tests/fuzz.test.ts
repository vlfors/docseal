/**
 * Robustness fuzzing: hostile input may only ever produce the parser's own error type, and
 * verification never throws, whatever the package. FUZZ_RUNS raises the number of cases.
 *
 *   FUZZ_RUNS=20000 pnpm vitest run tests/fuzz.test.ts
 */
import { FormatError, overallVerdict, parseJson, parseTrustedKeys, readContainer, utf8, verifyPackage, type AnchorReceipt } from "@docseal/core";
import { OtsError, openTimestamps, parseDetached } from "@docseal/anchor-ots";
import { KeyFileError, createKeyFile, ed25519Suite, generateSecretKey, openKeyFile, didToPublicKey } from "@docseal/sig-ed25519";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixture } from "./helpers.js";
import { mutatedPackage } from "./mutations.js";

const runs = Number(process.env.FUZZ_RUNS ?? 200);
const timeout = Math.max(30_000, runs * 50);

function onlyThrows(errorType: new (...args: never[]) => Error, f: () => unknown): void {
  try {
    f();
  } catch (error) {
    if (!(error instanceof errorType)) throw error;
  }
}

async function onlyRejects(errorType: new (...args: never[]) => Error, f: () => Promise<unknown>): Promise<void> {
  try {
    await f();
  } catch (error) {
    if (!(error instanceof errorType)) throw error;
  }
}

describe("packages", () => {
  it("verification of a mutated package never throws and reports consistent verdicts", { timeout }, async () => {
    await fc.assert(
      fc.asyncProperty(mutatedPackage, async (mutated) => {
        const zip = await mutated.bytes();
        await onlyRejects(FormatError, () => readContainer(zip));
        const report = await verifyPackage(zip, { suites: [ed25519Suite()], anchors: [openTimestamps()] });
        expect(report.overall).toBe(overallVerdict(report.axes));
        if (report.axes.format !== "valid") {
          expect(report.axes).toEqual({
            format: report.axes.format,
            integrity: "not-checked",
            signature: "missing",
            trust: "not-evaluated",
            time: "missing",
            completeness: "incomplete",
          });
        }
        // Nothing but an untouched package may verify cleanly on integrity and signature.
        if (report.axes.integrity === "valid" && report.axes.signature === "valid") {
          expect(report.issues.filter((i) => i.axis === "integrity" || i.axis === "signature")).toEqual([]);
        }
      }),
      { numRuns: runs },
    );
  });
});

describe("JSON", () => {
  it("parseJson only ever throws FormatError, and agrees with JSON.parse when it accepts", () => {
    const nearJson = fc.oneof(
      fc.uint8Array({ maxLength: 64 }),
      fc.json().chain((text) =>
        fc.tuple(fc.nat(), fc.constantFrom(...Array.from("{}[]\",:\\0e-+. \u0000\ud800é"))).map(([at, char]) => {
          const i = at % (text.length + 1);
          return utf8(text.slice(0, i) + char + text.slice(i));
        }),
      ),
    );
    fc.assert(
      fc.property(nearJson, (bytes) => {
        let value: unknown;
        try {
          value = parseJson(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(FormatError);
          return;
        }
        expect(value).toEqual(JSON.parse(new TextDecoder().decode(bytes)));
      }),
      { numRuns: runs * 5 },
    );
  });

  it("keeps a __proto__ key as an ordinary member", () => {
    const value = parseJson(utf8('{"__proto__":{"x":1},"a":2}')) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(value)).toBe(null);
  });

  it("parseTrustedKeys only ever throws FormatError", () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), fc.record({ type: fc.constant("docseal-trusted-keys"), version: fc.constantFrom(1, 2), keys: fc.array(fc.record({ id: fc.jsonValue(), label: fc.jsonValue() }, { requiredKeys: [] })) })), (value) => {
        onlyThrows(FormatError, () => parseTrustedKeys(utf8(JSON.stringify(value))));
      }),
      { numRuns: runs },
    );
  });
});

describe("OpenTimestamps", () => {
  const seeds = ["hello-world.txt.ots", "incomplete.txt.ots", "bad-stamp.txt.ots", "unknown-notary.txt.ots"].map(fixture);

  it("parseDetached only ever throws OtsError on mutated proofs", () => {
    fc.assert(
      fc.property(fc.nat(), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 }), fc.constantFrom("set", "insert", "delete")), { minLength: 1, maxLength: 4 }), (pick, edits) => {
        let proof = seeds[pick % seeds.length] ?? new Uint8Array();
        for (const [at, byte, op] of edits) {
          const i = at % (proof.length + 1);
          if (op === "set") proof = proof.map((b, j) => (j === i ? byte : b));
          else if (op === "insert") proof = new Uint8Array([...proof.subarray(0, i), byte, ...proof.subarray(i)]);
          else proof = new Uint8Array([...proof.subarray(0, i), ...proof.subarray(i + 1)]);
        }
        onlyThrows(OtsError, () => parseDetached(proof));
      }),
      { numRuns: runs * 5 },
    );
  });

  it("verify answers every receipt with a verdict instead of throwing", { timeout }, async () => {
    const provider = openTimestamps();
    const chain = { source: "fuzz", bitcoinBlockHeader: () => Promise.reject(new Error("offline")), bitcoinTipHeight: () => Promise.resolve(900_000) };
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.constantFrom("bip122:000000000019d6689c085ae165831e93", "x"), fc.uint8Array({ minLength: 32, maxLength: 32 }), async (proof, network, digest) => {
        const receipt: AnchorReceipt = { provider: "opentimestamps", network, digestAlgorithm: "sha-256", digest: Buffer.from(digest).toString("hex"), proof: Buffer.from(proof).toString("base64url") };
        const result = await provider.verify(receipt, digest, chain);
        expect(["confirmed", "pending", "invalid", "unsupported"]).toContain(result.verdict);
      }),
      { numRuns: runs },
    );
  });
});

describe("keys", () => {
  it("openKeyFile only ever throws KeyFileError on edited key files", { timeout }, async () => {
    const file = await createKeyFile(generateSecretKey(), "passphrase", { scryptN: 1024 });
    const text = JSON.stringify(file);
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.constantFrom(...Array.from("0123456789abcdef\"{}:,ANz_-")), async (at, char) => {
        const i = at % text.length;
        const edited = utf8(text.slice(0, i) + char + text.slice(i + 1));
        await onlyRejects(KeyFileError, () => openKeyFile(edited, "passphrase"));
      }),
      { numRuns: Math.max(20, runs / 10) },
    );
  });

  it("didToPublicKey rejects anything but an Ed25519 did:key, quickly", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string().map((s) => `did:key:z${s}`), fc.stringMatching(/^did:key:z[1-9A-HJ-NP-Za-km-z]{0,70}$/)), (did) => {
        const start = performance.now();
        onlyThrows(Error, () => didToPublicKey(did));
        expect(performance.now() - start).toBeLessThan(50);
      }),
      { numRuns: runs * 5 },
    );
  });
});
