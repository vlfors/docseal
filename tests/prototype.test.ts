/**
 * End-to-end check of the vertical prototype: seal → verify → mutate → invalid,
 * plus one test per relevant row of THREAT_MODEL.md.
 */
import {
  DocSeal,
  hash,
  jsonHash,
  parseJson,
  pinnedKeys,
  readContainer,
  signedBytes,
  toBase64url,
  toHex,
  utf8,
  verifyPackage,
  writeContainer,
  type PackageContents,
} from "@docseal/core";
import { ed25519Suite, generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

const author = memoryKeyProvider(generateSecretKey());
const attacker = memoryKeyProvider(generateSecretKey());

let docseal: DocSeal;
let sealed: Uint8Array;

beforeAll(async () => {
  docseal = new DocSeal({
    signatures: [ed25519Suite()],
    trust: pinnedKeys([{ id: await author.getSigner(), label: "Author" }]),
  });
  const result = await docseal.seal({
    files: [
      { path: "contract.pdf", data: utf8("%PDF-1.7 contract body"), mediaType: "application/pdf" },
      { path: "annex/annex-1.txt", data: utf8("Annex 1") },
      { path: "Договор.txt", data: utf8("Текст договора") },
    ],
    signer: author,
    role: "author",
    metadata: { title: "Supply agreement 17/2026" },
  });
  sealed = result.container;
});

/** Opens the sealed container, lets `change` edit it, and packs it again. */
function mutate(change: (contents: PackageContents) => void | Promise<void>): Promise<Uint8Array> {
  const contents = readContainer(sealed);
  return Promise.resolve(change(contents)).then(() => writeContainer(contents));
}

function json(bytes: Uint8Array | undefined): Record<string, unknown> {
  return parseJson(bytes ?? new Uint8Array()) as Record<string, unknown>;
}

function pretty(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value, null, 2));
}

describe("prototype", () => {
  it("verifies an untouched package on every axis except time", async () => {
    const report = await docseal.verify(sealed);
    expect(report.axes).toEqual({
      format: "valid",
      integrity: "valid",
      signature: "valid",
      trust: "trusted",
      time: "missing",
      completeness: "full",
    });
    // Without a confirmed anchor the package can never be fully valid.
    expect(report.overall).toBe("indeterminate");
    expect(report.files.map((f) => f.status)).toEqual(["valid", "valid", "valid"]);
    expect(report.issues).toEqual([]);
  });

  it("stores paths sorted by UTF-8 bytes", () => {
    const manifest = json(readContainer(sealed).manifest) as { files: { path: string }[] };
    expect(manifest.files.map((f) => f.path)).toEqual(["annex/annex-1.txt", "contract.pdf", "Договор.txt"]);
  });

  it("detects any single-byte change in any document", async () => {
    const contents = readContainer(sealed);
    const paths = [...contents.files.keys()];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...paths), fc.nat(), fc.integer({ min: 1, max: 255 }), async (path, at, xor) => {
        const zip = await mutate((c) => {
          const data = c.files.get(path);
          if (!data) throw new Error("missing");
          const copy = data.slice();
          const i = at % copy.length;
          copy[i] = (copy[i] ?? 0) ^ xor;
          c.files.set(path, copy);
        });
        const report = await docseal.verify(zip);
        expect(report.overall).toBe("invalid");
        expect(report.axes.integrity).toBe("invalid");
        expect(report.files.find((f) => f.path === path)?.status).toBe("modified");
      }),
      { numRuns: 50 },
    );
  });

  it("detects a missing file and an extra file", async () => {
    const missing = await docseal.verify(await mutate((c) => void c.files.delete("contract.pdf")));
    expect(missing.overall).toBe("invalid");
    expect(missing.axes.completeness).toBe("incomplete");
    expect(missing.files.find((f) => f.path === "contract.pdf")?.status).toBe("missing");

    const extra = await docseal.verify(await mutate((c) => void c.files.set("malware.exe", utf8("MZ"))));
    expect(extra.overall).toBe("invalid");
    expect(extra.files.find((f) => f.path === "malware.exe")?.status).toBe("extra");
  });

  it("detects a replaced document even when the manifest is recomputed", async () => {
    const zip = await mutate((c) => {
      const forged = utf8("%PDF-1.7 forged body");
      c.files.set("contract.pdf", forged);
      const manifest = json(c.manifest) as { files: { path: string; size: number; hash: string }[] };
      const entry = manifest.files.find((f) => f.path === "contract.pdf");
      if (!entry) throw new Error("missing");
      entry.size = forged.length;
      entry.hash = toHex(hash(forged));
      c.manifest = pretty(manifest);
    });
    const report = await docseal.verify(zip);
    expect(report.overall).toBe("invalid");
    expect(report.issues.map((i) => i.code)).toContain("manifest-hash");
  });

  it("detects a rename, because the path is part of the leaf", async () => {
    const zip = await mutate((c) => {
      const data = c.files.get("contract.pdf");
      if (!data) throw new Error("missing");
      c.files.delete("contract.pdf");
      c.files.set("contract-old.pdf", data);
      const manifest = json(c.manifest) as { files: { path: string }[] };
      const entry = manifest.files.find((f) => f.path === "contract.pdf");
      if (!entry) throw new Error("missing");
      entry.path = "contract-old.pdf";
      c.manifest = pretty(manifest);
    });
    const report = await docseal.verify(zip);
    expect(report.axes.integrity).toBe("invalid");
    expect(report.overall).toBe("invalid");
  });

  it("rejects a statement rewritten to match a forged manifest", async () => {
    const zip = await mutate((c) => {
      const manifest = json(c.manifest) as { metadata: { title: string } };
      manifest.metadata.title = "Forged title";
      c.manifest = pretty(manifest);
      const statement = json(c.statement);
      statement.manifestHash = toHex(jsonHash(manifest));
      c.statement = pretty(statement);
    });
    const report = await docseal.verify(zip);
    expect(report.axes.integrity).toBe("valid");
    expect(report.axes.signature).toBe("invalid");
    expect(report.issues.map((i) => i.code)).toContain("statement-hash");
    expect(report.overall).toBe("invalid");
  });

  it("rejects a change to a signed field of the envelope", async () => {
    const zip = await mutate((c) => {
      const envelope = json(c.signatures.get("signatures/0001.json")) as { protected: Record<string, unknown> };
      envelope.protected.role = "witness";
      c.signatures.set("signatures/0001.json", pretty(envelope));
    });
    const report = await docseal.verify(zip);
    expect(report.axes.signature).toBe("invalid");
    expect(report.overall).toBe("invalid");
  });

  it("marks a valid signature by an unknown key as untrusted, not valid", async () => {
    const zip = await mutate(async (c) => {
      const envelope = json(c.signatures.get("signatures/0001.json")) as { protected: Record<string, unknown>; value: string };
      envelope.protected.signer = await attacker.getSigner();
      envelope.value = toBase64url(await attacker.sign(signedBytes(envelope.protected)));
      c.signatures.set("signatures/0001.json", pretty(envelope));
    });
    const report = await docseal.verify(zip);
    expect(report.axes.signature).toBe("valid");
    expect(report.axes.trust).toBe("untrusted");
    expect(report.overall).toBe("indeterminate");
  });

  it("reports an unknown suite or critical extension as unsupported, not valid", async () => {
    for (const change of [{ suite: "gost-2012-256" }, { critical: ["x-future"] }]) {
      const zip = await mutate((c) => {
        const envelope = json(c.signatures.get("signatures/0001.json")) as { protected: Record<string, unknown> };
        Object.assign(envelope.protected, change);
        c.signatures.set("signatures/0001.json", pretty(envelope));
      });
      const report = await docseal.verify(zip);
      expect(report.axes.signature).toBe("unsupported");
      expect(report.axes.completeness).toBe("incomplete");
      expect(report.overall).toBe("indeterminate");
    }
  });

  it("reports a package without signatures as missing a signature", async () => {
    const report = await docseal.verify(await mutate((c) => {
      c.signatures.clear();
    }));
    expect(report.axes.signature).toBe("missing");
    expect(report.overall).toBe("indeterminate");
  });

  it("rejects the same envelope included twice", async () => {
    const zip = await mutate((c) => {
      const envelope = c.signatures.get("signatures/0001.json");
      if (!envelope) throw new Error("missing");
      c.signatures.set("signatures/0002.json", envelope);
    });
    const report = await docseal.verify(zip);
    expect(report.axes.signature).toBe("invalid");
  });

  it("does not evaluate trust without a policy", async () => {
    const report = await verifyPackage(sealed, { suites: docseal.signatures });
    expect(report.axes.trust).toBe("not-evaluated");
    expect(report.overall).toBe("indeterminate");
  });

  it("reports unsupported format versions and garbage input without throwing", async () => {
    const future = await mutate((c) => {
      const statement = json(c.statement);
      statement.version = 2;
      c.statement = pretty(statement);
    });
    expect((await docseal.verify(future)).axes.format).toBe("unsupported");
    expect((await docseal.verify(utf8("not a zip"))).axes.format).toBe("invalid");
  });
});
