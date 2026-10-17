import {
  DocSeal,
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
  it("rejects two suites claiming the same profile", () => {
    expect(() => new DocSeal({ signatures: [ed25519Suite(), ed25519Suite()] })).toThrow(/Duplicate/);
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

    const contents = readContainer(container);
    const original = parseJson(contents.signatures.get("signatures/0001.json") ?? new Uint8Array()) as SignatureEnvelope;
    const header = { ...original.protected, signer: await stranger.getSigner(), role: "approver" };
    const added: SignatureEnvelope = { protected: header, value: toBase64url(await stranger.sign(signedBytes(header))) };
    contents.signatures.set("signatures/0002.json", utf8(JSON.stringify(added)));

    const report = await docseal.verify(writeContainer(contents));
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
