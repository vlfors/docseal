import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { FormatError } from "./errors.js";
import { parseTrustedKeys, pinnedKeys } from "./trust.js";

const context = { attestedAt: null };

describe("pinnedKeys", () => {
  it("trusts listed signers and names them", async () => {
    const policy = pinnedKeys([{ id: "did:key:a", label: "Alice" }, "did:key:b"]);
    await expect(policy.evaluate("did:key:a", context)).resolves.toEqual({ verdict: "trusted", reason: "Pinned key: Alice" });
    await expect(policy.evaluate("did:key:b", context)).resolves.toMatchObject({ verdict: "trusted" });
  });

  it("does not trust anything else, including near matches", async () => {
    const policy = pinnedKeys(["did:key:a"]);
    for (const signer of ["did:key:b", "did:key:A", "did:key:a ", ""]) {
      await expect(policy.evaluate(signer, context)).resolves.toMatchObject({ verdict: "untrusted" });
    }
  });

  it("rejects a key listed twice", () => {
    expect(() => pinnedKeys(["did:key:a", { id: "did:key:a" }])).toThrow(FormatError);
  });
});

describe("parseTrustedKeys", () => {
  const file = (value: unknown) => utf8(JSON.stringify(value));

  it("parses a valid file", () => {
    const parsed = parseTrustedKeys(
      file({ type: "docseal-trusted-keys", version: 1, keys: [{ id: "did:key:a", label: "Alice" }, { id: "did:key:b" }] }),
    );
    expect(parsed.keys.map((k) => k.id)).toEqual(["did:key:a", "did:key:b"]);
  });

  it.each([
    [{ type: "other", version: 1, keys: [] }],
    [{ type: "docseal-trusted-keys", version: 1 }],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{}] }],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: "" }] }],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: "a", label: 1 }] }],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: "a" }, { id: "a" }] }],
    [[]],
  ])("rejects %j", (value) => {
    expect(() => parseTrustedKeys(file(value))).toThrow(FormatError);
  });

  it("reports a future version as unsupported", () => {
    try {
      parseTrustedKeys(file({ type: "docseal-trusted-keys", version: 2, keys: [] }));
      expect.unreachable();
    } catch (error) {
      expect((error as FormatError).verdict).toBe("unsupported");
    }
  });
});
