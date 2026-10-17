import {
  DocSeal,
  FormatError,
  parseJson,
  pinnedKeys,
  readContainer,
  signedBytes,
  toBase64url,
  utf8,
  writeContainer,
  type KeyProvider,
  type SignatureEnvelope,
  type SignatureSuite,
} from "@docseal/core";
import { ed25519Suite, generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";
import { describe, expect, it } from "vitest";

const files = [{ path: "a.txt", data: utf8("hello") }];

describe("DocSeal registry", () => {
  it("rejects two suites claiming the same profile, and two anchor providers with the same id", () => {
    expect(() => new DocSeal({ signatures: [ed25519Suite(), ed25519Suite()] })).toThrow("Duplicate signature suite profile: ed25519/docseal-ed25519-v1");
    const provider = { id: "p", submit: () => Promise.reject(new Error("unused")), verify: () => Promise.reject(new Error("unused")) };
    expect(() => new DocSeal({ signatures: [], anchors: [provider, { ...provider }] })).toThrow("Duplicate anchor provider: p");
  });

  it("allows one suite with several profiles, and one profile name under different suites", () => {
    const suite = (id: string, profiles: string[]): SignatureSuite => ({ id, profiles, verify: () => Promise.resolve("valid") });
    expect(() => new DocSeal({ signatures: [suite("a", ["v1", "v2"]), suite("b", ["v1"])] })).not.toThrow();
    expect(() => new DocSeal({ signatures: [suite("a", ["v1"]), suite("a", ["v2"])] })).not.toThrow();
  });

  it("refuses to seal without files", async () => {
    const docseal = new DocSeal({ signatures: [ed25519Suite()] });
    await expect(docseal.seal({ files: [], signer: memoryKeyProvider(generateSecretKey()) })).rejects.toThrow(new FormatError("empty", "A package needs at least one file"));
  });

  it("writes the optional generator, role, and attributes only when given", async () => {
    const docseal = new DocSeal({ signatures: [ed25519Suite()] });
    const signer = memoryKeyProvider(generateSecretKey());
    const read = async (container: Uint8Array) => {
      const contents = await readContainer(container);
      return {
        manifest: parseJson(contents.manifest) as Record<string, unknown>,
        header: (parseJson(contents.signatures.get("signatures/0001.json") ?? new Uint8Array()) as SignatureEnvelope).protected as unknown as Record<string, unknown>,
      };
    };
    const plain = await read((await docseal.seal({ files, signer })).container);
    expect("generator" in plain.manifest).toBe(false);
    expect("role" in plain.header || "attributes" in plain.header).toBe(false);
    const full = await read((await docseal.seal({ files, signer, generator: "gen 1", role: "author", attributes: { x: 1 } })).container);
    expect(full.manifest.generator).toBe("gen 1");
    expect(full.header).toMatchObject({ role: "author", attributes: { x: 1 } });
  });

  it("leaves receipts alone whose provider is not registered or cannot upgrade", async () => {
    const pending = (id: string) => ({
      id,
      submit: (digest: Uint8Array) => Promise.resolve({ provider: id, network: "n", digestAlgorithm: "sha-256", digest: Buffer.from(digest).toString("hex"), proof: "AA" }),
      verify: () => Promise.resolve({ verdict: "pending" as const }),
    });
    const signer = memoryKeyProvider(generateSecretKey());
    const { container } = await new DocSeal({ signatures: [ed25519Suite()], anchors: [pending("gone"), pending("static")] }).seal({ files, signer });
    const upgraded = await new DocSeal({ signatures: [ed25519Suite()], anchors: [pending("static")] }).upgrade(container);
    expect(upgraded.changed).toBe(false);
    expect(upgraded.container).toEqual(container);
  });

  it("refuses to seal with a key whose suite is not registered", async () => {
    const docseal = new DocSeal({ signatures: [] });
    await expect(docseal.seal({ files, signer: memoryKeyProvider(generateSecretKey()) })).rejects.toThrow(
      /No registered signature suite/,
    );
  });

  it("refuses to return a package whose signature does not verify", async () => {
    const real = memoryKeyProvider(generateSecretKey());
    const other = memoryKeyProvider(generateSecretKey());
    // Claims one key but signs with another, like a misconfigured HSM slot.
    const broken: KeyProvider = { ...real, sign: (bytes) => other.sign(bytes) };
    const docseal = new DocSeal({ signatures: [ed25519Suite()] });
    await expect(docseal.seal({ files, signer: broken })).rejects.toThrow(/does not verify/);
  });

  it("only runs registered suites, whatever the package names", async () => {
    const signer = memoryKeyProvider(generateSecretKey());
    const { container } = await new DocSeal({ signatures: [ed25519Suite()] }).seal({ files, signer });

    // An application that registered a different suite cannot be tricked into
    // running ed25519, or anything else the package asks for.
    const calls: string[] = [];
    const other: SignatureSuite = {
      id: "other",
      profiles: ["other-v1"],
      verify: (s) => {
        calls.push(s);
        return Promise.resolve("valid");
      },
    };
    const report = await new DocSeal({ signatures: [other] }).verify(container);
    expect(report.axes.signature).toBe("unsupported");
    expect(calls).toEqual([]);
  });

  it("uses the configured trust policy and allows a per-call override", async () => {
    const signer = memoryKeyProvider(generateSecretKey());
    const id = await signer.getSigner();
    const docseal = new DocSeal({ signatures: [ed25519Suite()], trust: pinnedKeys([id]) });
    const { container } = await docseal.seal({ files, signer });

    expect((await docseal.verify(container)).axes.trust).toBe("trusted");
    expect((await docseal.verify(container, { trust: pinnedKeys(["did:key:someone-else"]) })).axes.trust).toBe(
      "untrusted",
    );
  });

  it("does not let an unknown co-signer borrow the trust of a pinned signer", async () => {
    const alice = memoryKeyProvider(generateSecretKey());
    const stranger = memoryKeyProvider(generateSecretKey());
    const docseal = new DocSeal({ signatures: [ed25519Suite()], trust: pinnedKeys([await alice.getSigner()]) });
    const { container } = await docseal.seal({ files, signer: alice });

    const contents = await readContainer(container);
    const original = parseJson(contents.signatures.get("signatures/0001.json") ?? new Uint8Array()) as SignatureEnvelope;
    const header = { ...original.protected, signer: await stranger.getSigner(), role: "approver" };
    const added: SignatureEnvelope = { protected: header, value: toBase64url(await stranger.sign(signedBytes(header))) };
    contents.signatures.set("signatures/0002.json", utf8(JSON.stringify(added)));

    const report = await docseal.verify(await writeContainer(contents));
    expect(report.axes.signature).toBe("valid");
    expect(report.axes.trust).toBe("untrusted");
    expect(report.overall).toBe("indeterminate");
  });

  it("applies configured container limits", async () => {
    const signer = memoryKeyProvider(generateSecretKey());
    const { container } = await new DocSeal({ signatures: [ed25519Suite()] }).seal({ files, signer });
    const strict = new DocSeal({ signatures: [ed25519Suite()], limits: { maxDocumentSize: 4 } });
    expect((await strict.verify(container)).axes.format).toBe("invalid");
  });
});
