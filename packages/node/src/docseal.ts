import { esploraChainReader, firstAvailableChainReader, openTimestamps, type Fetch } from "@docseal/anchor-ots";
import { DocSeal, parseTrustedKeys, pinnedKeys, type TrustPolicy } from "@docseal/core";
import { ed25519Suite, openKeyFile } from "@docseal/sig-ed25519";
import { createHash } from "node:crypto";
import { readInput } from "./files.js";

/** Where a passphrase for a key file comes from when nobody can type it. */
export const PASSPHRASE_ENV = "DOCSEAL_PASSPHRASE";

export interface DocSealSettings {
  /** Network access for calendars and chain sources. Defaults to global fetch. */
  fetch?: Fetch | undefined;
  /** Register the OpenTimestamps provider. Without it nothing is submitted and time proofs are not read. Default true. */
  anchor?: boolean;
  /** OpenTimestamps calendars to submit seals to, instead of the defaults. */
  calendars?: readonly string[] | undefined;
  /** Bitcoin confirmations a time proof needs to be confirmed. */
  minConfirmations?: number | undefined;
  /** Esplora APIs for Bitcoin block headers, tried in order. None: time proofs stay unchecked. */
  chain?: readonly string[] | undefined;
  trust?: TrustPolicy | undefined;
}

/** A DocSeal with the plugins every Node.js front end registers: Ed25519, OpenTimestamps, native SHA-256. */
export function createDocSeal(settings: DocSealSettings = {}): DocSeal {
  const http = settings.fetch ? { fetch: settings.fetch } : {};
  const anchor = openTimestamps({
    ...http,
    ...(settings.calendars ? { calendars: settings.calendars } : {}),
    ...(settings.minConfirmations === undefined ? {} : { minConfirmations: settings.minConfirmations }),
  });
  return new DocSeal({
    signatures: [ed25519Suite()],
    anchors: settings.anchor === false ? [] : [anchor],
    ...(settings.trust ? { trust: settings.trust } : {}),
    ...(settings.chain && settings.chain.length > 0
      ? { chain: firstAvailableChainReader(settings.chain.map((url) => esploraChainReader(url, http))) }
      : {}),
    sha256: nodeSha256,
  });
}

/** The signers in a trusted-keys.json file, as a trust policy. */
export async function readTrustedKeys(path: string): Promise<TrustPolicy> {
  return pinnedKeys(parseTrustedKeys(await readInput(path, "trusted keys file")).keys);
}

/**
 * Opens a key file, asking for its passphrase only once the file has been read.
 * The caller must zero `seed` once it is done with it.
 */
export async function openKey(path: string, passphrase: () => Promise<string>): Promise<{ seed: Uint8Array; did: string }> {
  const bytes = await readInput(path, "key file");
  return openKeyFile(bytes, await passphrase());
}

/** Node's native SHA-256: several times faster than portable JavaScript on large documents. */
export function nodeSha256() {
  const h = createHash("sha256");
  return {
    update(chunk: Uint8Array) {
      h.update(chunk);
    },
    digest: () => new Uint8Array(h.digest()),
  };
}
