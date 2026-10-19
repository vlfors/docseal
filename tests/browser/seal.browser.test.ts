/**
 * Sealing in each browser engine, with the web app's own sealing code: the same inputs, clock,
 * and randomness give the same bytes as in Node.js (tests/browser/sealed-reference.ts).
 */
import { hash, memorySink, toHex, verifyPackage } from "@docseal/core";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { describe, expect, inject, it } from "vitest";
import { sealFiles } from "../../apps/web/src/lib/seal/seal";
import { inputs, NOW, randomBytes, SECRET_KEY } from "./seal-inputs";

describe("sealing", () => {
  it("gives the same bytes as in Node.js", async () => {
    const sink = memorySink();
    await sealFiles(sink, { files: inputs(), secretKey: SECRET_KEY, role: "author", now: () => NOW, randomBytes: randomBytes() });
    const bytes = sink.bytes();
    expect(toHex(hash(bytes))).toBe(inject("referencePackage"));
    const report = await verifyPackage(bytes, { suites: [ed25519Suite()] });
    expect(report.axes).toMatchObject({ format: "valid", integrity: "valid", signature: "valid" });
  });
});
