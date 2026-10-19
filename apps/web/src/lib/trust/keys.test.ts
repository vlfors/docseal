import { utf8 } from "@docseal/core";
import { publicKeyToDid } from "@docseal/sig-ed25519";
import { describe, expect, it } from "vitest";
import { addKey, exportKeys, importKeys, loadKeys, removeKey, saveKeys, STORAGE_KEY } from "./keys";

const did = (byte: number) => publicKeyToDid(new Uint8Array(32).fill(byte));
const A = did(1);
const B = did(2);

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

describe("trusted keys", () => {
  it("adds an Ed25519 did:key with an optional name, once", () => {
    const one = addKey([], ` ${A} `, " Author ");
    expect(one).toEqual({ keys: [{ id: A, label: "Author" }] });
    const keys = "keys" in one ? one.keys : [];
    expect(addKey(keys, B, "")).toEqual({ keys: [{ id: A, label: "Author" }, { id: B }] });
    expect(addKey(keys, A, "again")).toEqual({ error: "duplicate" });
    expect(addKey(keys, "did:key:zNotAKey", "")).toEqual({ error: "invalidDid" });
    expect(addKey(keys, "did:web:example.com", "")).toEqual({ error: "invalidDid" });
  });

  it("removes a key", () => {
    expect(removeKey([{ id: A }, { id: B }], A)).toEqual([{ id: B }]);
  });

  it("imports a trusted-keys.json, keeping the names of keys already listed", () => {
    const file = exportKeys([{ id: A, label: "Other name" }, { id: B, label: "Approver" }]);
    expect(importKeys([{ id: A, label: "Author" }], file)).toEqual({
      keys: [{ id: A, label: "Author" }, { id: B, label: "Approver" }],
      added: 1,
      skipped: 1,
    });
  });

  it("rejects a file that is not a trusted keys file, with the core's reason", () => {
    expect(importKeys([], utf8('{"type":"something-else"}'))).toEqual({ error: "Trusted keys file: expected type 'docseal-trusted-keys'" });
    expect(importKeys([], utf8("not json"))).toHaveProperty("error");
  });

  it("exports a file the core and the CLI read", () => {
    const text = new TextDecoder().decode(exportKeys([{ id: A, label: "Author" }]));
    expect(JSON.parse(text)).toEqual({ type: "docseal-trusted-keys", version: 1, keys: [{ id: A, label: "Author" }] });
  });

  it("stores the list and reads it back; a damaged entry reads as empty", () => {
    const storage = memoryStorage();
    expect(loadKeys(storage)).toEqual([]);
    saveKeys(storage, [{ id: A, label: "Author" }]);
    expect(loadKeys(storage)).toEqual([{ id: A, label: "Author" }]);
    expect(loadKeys(memoryStorage({ [STORAGE_KEY]: "{broken" }))).toEqual([]);
  });
});
