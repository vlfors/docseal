/** OpenTimestamps anchor provider (FORMAT-v0.1 §OpenTimestamps). */
import {
  equalBytes,
  fromBase64url,
  toBase64url,
  toHex,
  type AnchorProvider,
  type AnchorReceipt,
  type AnchorResult,
  type ChainReader,
} from "@docseal/core";
import { HttpError, request, type HttpOptions } from "./http.js";
import {
  attestations,
  mergeTimestamps,
  OtsError,
  parseDetached,
  parseTimestamp,
  serializeDetached,
  type DetachedTimestamp,
  type Timestamp,
} from "./ots.js";

export { firstAvailableChainReader } from "./chain.js";
export { DEFAULT_ESPLORA_URL, DEFAULT_ESPLORA_URLS, esploraChainReader, parseBlockHeader } from "./esplora.js";
export type { Fetch, HttpOptions } from "./http.js";
export * from "./ots.js";

export const PROVIDER_ID = "opentimestamps";
export const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93";
export const DEFAULT_MIN_CONFIRMATIONS = 6;

/** Aggregation servers that accept new digests. */
export const DEFAULT_CALENDARS = [
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://a.pool.eternitywall.com",
  "https://ots.btc.catallaxy.com",
];

/**
 * Calendars a pending attestation may be upgraded from. The URL comes from the proof, i.e.
 * from the package, so it is never fetched unless it matches one of these.
 */
export const DEFAULT_UPGRADE_ALLOWLIST = [
  "https://*.calendar.opentimestamps.org",
  "https://*.calendar.eternitywall.com",
  "https://*.calendar.catallaxy.com",
];

const ACCEPT = "application/vnd.opentimestamps.v1";
/** Real proofs carry one or two Bitcoin attestations; each one costs two chain requests. */
const MAX_BITCOIN_ATTESTATIONS = 8;
const MAX_RESPONSE_BYTES = 10_000;

export interface OpenTimestampsOptions extends HttpOptions {
  calendars?: readonly string[];
  /** Calendars that must accept a digest for `submit` to succeed. Defaults to min(2, calendars). */
  minCalendars?: number;
  upgradeAllowlist?: readonly string[];
  minConfirmations?: number;
}

export function openTimestamps(options: OpenTimestampsOptions = {}): AnchorProvider {
  const calendars = options.calendars ?? DEFAULT_CALENDARS;
  const minCalendars = options.minCalendars ?? Math.min(2, calendars.length);
  const allowlist = options.upgradeAllowlist ?? DEFAULT_UPGRADE_ALLOWLIST;
  const minConfirmations = options.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS;
  const headers = { Accept: ACCEPT, "User-Agent": "docseal" };

  return {
    id: PROVIDER_ID,

    async submit(digest) {
      const root: Timestamp = { msg: digest, attestations: [], ops: [] };
      const failures: string[] = [];
      const responses = await Promise.allSettled(
        calendars.map((calendar) =>
          request(
            `${calendar.replace(/\/+$/, "")}/digest`,
            { method: "POST", body: new Uint8Array(digest), headers, maxBytes: MAX_RESPONSE_BYTES },
            options,
          ),
        ),
      );
      let accepted = 0;
      responses.forEach((response, i) => {
        try {
          if (response.status === "rejected") {
            throw response.reason;
          }
          mergeTimestamps(root, parseTimestamp(response.value, digest));
          accepted++;
        } catch (error) {
          failures.push(`${calendars[i] ?? "?"}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      if (accepted < minCalendars) {
        throw new Error(
          `Only ${String(accepted)} of ${String(calendars.length)} calendars accepted the digest (need ${String(minCalendars)}): ${failures.join("; ")}`,
        );
      }
      return toReceipt({ hashOp: "sha256", timestamp: root }, timestamp(new Date()));
    },

    async upgrade(receipt) {
      const detached = decodeProof(receipt);
      for (const { attestation, msg, node } of attestations(detached.timestamp)) {
        if (attestation.kind !== "pending" || !isAllowed(attestation.uri, allowlist)) {
          continue;
        }
        try {
          const body = await request(
            `${attestation.uri.replace(/\/+$/, "")}/timestamp/${toHex(msg)}`,
            { headers, maxBytes: MAX_RESPONSE_BYTES },
            options,
          );
          mergeTimestamps(node, parseTimestamp(body, msg));
        } catch (error) {
          // 404 means the calendar has not committed to Bitcoin yet; try again later.
          if (!(error instanceof HttpError && error.status === 404) && !(error instanceof OtsError)) {
            throw error;
          }
        }
      }
      return toReceipt(detached, receipt.cached?.submittedAt);
    },

    verify(receipt, digest, chain) {
      return verifyReceipt(receipt, digest, chain, minConfirmations);
    },
  };
}

async function verifyReceipt(
  receipt: AnchorReceipt,
  digest: Uint8Array,
  chain: ChainReader,
  minConfirmations: number,
): Promise<AnchorResult> {
  if (receipt.network !== BITCOIN_MAINNET) {
    return { verdict: "unsupported", reason: `Network ${receipt.network} is not supported` };
  }
  let detached: DetachedTimestamp;
  try {
    detached = decodeProof(receipt);
  } catch (error) {
    return { verdict: "invalid", reason: `Malformed proof: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!equalBytes(detached.timestamp.msg, digest) || receipt.digest !== toHex(digest)) {
    return { verdict: "invalid", reason: "Proof is for a different digest" };
  }

  const found = attestations(detached.timestamp);
  // Repeated identical attestations would otherwise turn one proof into millions of requests.
  const bitcoin = [
    ...new Map(
      found.flatMap(({ attestation, msg }) =>
        attestation.kind === "bitcoin" ? [[`${String(attestation.height)}:${toHex(msg)}`, { height: attestation.height, msg }] as const] : [],
      ),
    ).values(),
  ];
  if (bitcoin.length > MAX_BITCOIN_ATTESTATIONS) {
    return { verdict: "invalid", reason: `Proof has more than ${String(MAX_BITCOIN_ATTESTATIONS)} Bitcoin attestations` };
  }
  if (bitcoin.length === 0) {
    return found.some(({ attestation }) => attestation.kind === "pending")
      ? { verdict: "pending", reason: "Waiting for a Bitcoin confirmation; run upgrade later" }
      : { verdict: "unsupported", reason: "Proof has no Bitcoin attestation" };
  }
  if (!chain.bitcoinBlockHeader || !chain.bitcoinTipHeight) {
    return { verdict: "unsupported", reason: `Chain source ${chain.source} cannot read Bitcoin headers` };
  }

  let earliest: { time: number; confirmations: number; height: number } | undefined;
  try {
    const tip = await chain.bitcoinTipHeight();
    const headers = new Map<number, Awaited<ReturnType<NonNullable<ChainReader["bitcoinBlockHeader"]>>>>();
    for (const { height, msg } of bitcoin) {
      const header = headers.get(height) ?? (await chain.bitcoinBlockHeader(height));
      headers.set(height, header);
      // A proof that claims a block it is not in is forged or corrupt, even if another
      // attestation in it is genuine.
      if (!equalBytes(msg, header.merkleRoot)) {
        return { verdict: "invalid", source: chain.source, reason: `Proof does not match Bitcoin block ${String(height)}` };
      }
      const confirmations = tip - height + 1;
      if (!earliest || header.time < earliest.time) {
        earliest = { time: header.time, confirmations, height };
      }
    }
  } catch (error) {
    return {
      verdict: "unsupported",
      source: chain.source,
      reason: `Chain source unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!earliest || earliest.confirmations < minConfirmations) {
    return {
      verdict: "pending",
      source: chain.source,
      ...(earliest ? { confirmations: earliest.confirmations, blockHeight: earliest.height } : {}),
      reason: `Fewer than ${String(minConfirmations)} confirmations`,
    };
  }
  return {
    verdict: "confirmed",
    attestedAt: new Date(earliest.time * 1000),
    confirmations: earliest.confirmations,
    blockHeight: earliest.height,
    source: chain.source,
  };
}

function decodeProof(receipt: AnchorReceipt): DetachedTimestamp {
  if (receipt.provider !== PROVIDER_ID) {
    throw new OtsError(`Not an OpenTimestamps receipt: ${receipt.provider}`);
  }
  return parseDetached(fromBase64url(receipt.proof));
}

/** `submittedAt` is when the seal went to the calendars; an upgrade keeps it as it was, and never invents one. */
function toReceipt(detached: DetachedTimestamp, submittedAt: string | undefined): AnchorReceipt {
  const found = attestations(detached.timestamp);
  const heights = found.flatMap(({ attestation }) => (attestation.kind === "bitcoin" ? [attestation.height] : []));
  return {
    provider: PROVIDER_ID,
    network: BITCOIN_MAINNET,
    digestAlgorithm: "sha-256",
    digest: toHex(detached.timestamp.msg),
    proof: toBase64url(serializeDetached(detached)),
    cached: {
      status: heights.length > 0 ? "confirmed" : "pending",
      ...(submittedAt !== undefined && { submittedAt }),
      ...(heights.length > 0 && { blockHeight: Math.min(...heights) }),
    },
  };
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Matches `https://host` or `https://*.domain` patterns against an https URL with no path. */
export function isAllowed(uri: string, patterns: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || (url.pathname !== "/" && url.pathname !== "")) {
    return false;
  }
  return patterns.some((pattern) => {
    const host = pattern.replace(/^https:\/\//, "");
    return host.startsWith("*.")
      ? url.hostname.endsWith(host.slice(1)) && url.hostname.length > host.length - 1
      : url.hostname === host;
  });
}
