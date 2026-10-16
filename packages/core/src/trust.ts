/** Pinned-keys trust policy and its file format (FORMAT-v0.1 §Trusted keys file). */
import { FormatError } from "./errors.js";
import { parseJson } from "./json.js";
import type { TrustPolicy } from "./plugins.js";

export interface TrustedKey {
  /** Signer identifier exactly as it appears in `protected.signer`, e.g. a `did:key`. */
  id: string;
  /** Human-readable name, shown in reports. Not verified by DocSeal. */
  label?: string;
}

export interface TrustedKeysFile {
  type: "docseal-trusted-keys";
  version: 1;
  keys: TrustedKey[];
}

/** Trusts exactly the listed signer identifiers. */
export function pinnedKeys(keys: readonly (TrustedKey | string)[]): TrustPolicy {
  const byId = new Map<string, TrustedKey>();
  for (const key of keys) {
    const entry = typeof key === "string" ? { id: key } : key;
    if (byId.has(entry.id)) {
      throw new FormatError("trusted-keys", `Key ${entry.id} is listed twice`);
    }
    byId.set(entry.id, entry);
  }
  return {
    id: "pinned-keys",
    evaluate(signer) {
      const key = byId.get(signer);
      return Promise.resolve(
        key
          ? { verdict: "trusted", reason: key.label === undefined ? "Pinned key" : `Pinned key: ${key.label}` }
          : { verdict: "untrusted", reason: "Signer is not in the pinned key list" },
      );
    },
  };
}

export function parseTrustedKeys(bytes: Uint8Array): TrustedKeysFile {
  const fail = (message: string) => new FormatError("trusted-keys", `Trusted keys file: ${message}`);
  const value = parseJson(bytes);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("expected an object");
  }
  const file = value as Record<string, unknown>;
  if (file.type !== "docseal-trusted-keys") {
    throw fail("expected type 'docseal-trusted-keys'");
  }
  if (file.version !== 1) {
    throw new FormatError("trusted-keys", "Trusted keys file: unsupported version", "unsupported");
  }
  if (!Array.isArray(file.keys)) {
    throw fail("'keys' must be an array");
  }
  const seen = new Set<string>();
  for (const [i, item] of file.keys.entries()) {
    const key = item as Record<string, unknown> | null;
    if (typeof key !== "object" || key === null || typeof key.id !== "string" || key.id === "") {
      throw fail(`keys[${String(i)}].id must be a non-empty string`);
    }
    if (key.label !== undefined && typeof key.label !== "string") {
      throw fail(`keys[${String(i)}].label must be a string`);
    }
    if (seen.has(key.id)) {
      throw fail(`key ${key.id} is listed twice`);
    }
    seen.add(key.id);
  }
  return file as unknown as TrustedKeysFile;
}
