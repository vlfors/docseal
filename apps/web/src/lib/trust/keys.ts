/**
 * The viewer's trusted keys, kept in the browser in the trusted-keys.json format
 * (FORMAT-v0.1 §Trusted keys file), so storage, import, and export share one parser: the core's.
 */
import { FormatError, parseTrustedKeys, utf8, type TrustedKey, type TrustedKeysFile } from "@docseal/core";
import { didToPublicKey } from "@docseal/sig-ed25519";

export const STORAGE_KEY = "docseal.trustedKeys";

export type AddResult = { keys: TrustedKey[] } | { error: "invalidDid" | "duplicate" };

/** `keys` with `id` added, if it is an Ed25519 did:key not yet in the list. */
export function addKey(keys: readonly TrustedKey[], id: string, label: string): AddResult {
  const did = id.trim();
  try {
    didToPublicKey(did);
  } catch {
    return { error: "invalidDid" };
  }
  if (keys.some((key) => key.id === did)) {
    return { error: "duplicate" };
  }
  const name = label.trim();
  return { keys: [...keys, { id: did, ...(name !== "" && { label: name }) }] };
}

export function removeKey(keys: readonly TrustedKey[], id: string): TrustedKey[] {
  return keys.filter((key) => key.id !== id);
}

export type ImportResult = { keys: TrustedKey[]; added: number; skipped: number } | { error: string };

/** `keys` with the keys of a trusted-keys.json added; keys already in the list keep their names. */
export function importKeys(keys: readonly TrustedKey[], bytes: Uint8Array): ImportResult {
  let file: TrustedKeysFile;
  try {
    file = parseTrustedKeys(bytes);
  } catch (error) {
    if (error instanceof FormatError) {
      return { error: error.message };
    }
    throw error;
  }
  const known = new Set(keys.map((key) => key.id));
  const added = file.keys.filter((key) => !known.has(key.id)).map((key) => ({ id: key.id, ...(key.label !== undefined && { label: key.label }) }));
  return { keys: [...keys, ...added], added: added.length, skipped: file.keys.length - added.length };
}

export function exportKeys(keys: readonly TrustedKey[]): Uint8Array {
  const file: TrustedKeysFile = { type: "docseal-trusted-keys", version: 1, keys: [...keys] };
  return utf8(`${JSON.stringify(file, null, 2)}\n`);
}

/** The stored list; an unreadable or damaged entry gives an empty list rather than a broken page. */
export function loadKeys(storage: Pick<Storage, "getItem">): TrustedKey[] {
  const text = storage.getItem(STORAGE_KEY);
  if (text === null) {
    return [];
  }
  try {
    return parseTrustedKeys(utf8(text)).keys;
  } catch {
    return [];
  }
}

export function saveKeys(storage: Pick<Storage, "setItem">, keys: readonly TrustedKey[]): void {
  storage.setItem(STORAGE_KEY, new TextDecoder().decode(exportKeys(keys)));
}
