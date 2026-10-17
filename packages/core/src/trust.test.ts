import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { FormatError } from "./errors.js";
import { parseTrustedKeys, pinnedKeys } from "./trust.js";

const context = { attestedAt: null };

function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (error) {
    return error;
  }
  return expect.unreachable();
}

describe("pinnedKeys", () => {
  it("trusts listed signers and names them", async () => {
    const policy = pinnedKeys([{ id: "did:key:a", label: "Alice" }, "did:key:b"]);
    await expect(policy.evaluate("did:key:a", context)).resolves.toEqual({ verdict: "trusted", reason: "Pinned key: Alice" });
    await expect(policy.evaluate("did:key:b", context)).resolves.toEqual({ verdict: "trusted", reason: "Pinned key" });
  });

  it("does not trust anything else, including near matches", async () => {
    const policy = pinnedKeys(["did:key:a"]);
    for (const signer of ["did:key:b", "did:key:A", "did:key:a ", ""]) {
      await expect(policy.evaluate(signer, context)).resolves.toEqual({ verdict: "untrusted", reason: "Signer is not in the pinned key list" });
    }
  });

  it("rejects a key listed twice", () => {
    expect(thrown(() => pinnedKeys(["did:key:a", { id: "did:key:a" }]))).toEqual(new FormatError("trusted-keys", "Key did:key:a is listed twice"));
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
    [{ type: "other", version: 1, keys: [] }, "expected type 'docseal-trusted-keys'"],
    [{ type: "docseal-trusted-keys", version: 1 }, "'keys' must be an array"],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{}] }, "keys[0].id must be a non-empty string"],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: "a" }, null] }, "keys[1].id must be a non-empty string"],
    [{ type: "docseal-trusted-keys", version: 1, keys: ["a"] }, "keys[0].id must be a non-empty string"],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: 1 }] }, "keys[0].id must be a non-empty string"],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: "" }] }, "keys[0].id must be a non-empty string"],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: "a", label: 1 }] }, "keys[0].label must be a string"],
    [{ type: "docseal-trusted-keys", version: 1, keys: [{ id: "a" }, { id: "a" }] }, "key a is listed twice"],
    [[], "expected an object"],
    [null, "expected an object"],
  ])("rejects %j", (value, message) => {
    expect(thrown(() => parseTrustedKeys(file(value)))).toEqual(new FormatError("trusted-keys", `Trusted keys file: ${message}`));
  });

  it("reports a future version as unsupported", () => {
    try {
      parseTrustedKeys(file({ type: "docseal-trusted-keys", version: 2, keys: [] }));
      expect.unreachable();
    } catch (error) {
      expect(error).toEqual(new FormatError("trusted-keys", "Trusted keys file: unsupported version", "unsupported"));
      expect((error as FormatError).verdict).toBe("unsupported");
    }
  });
});
