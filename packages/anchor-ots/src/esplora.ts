/**
 * ChainReader backed by an Esplora HTTP API (mempool.space, blockstream.info, or a self-hosted
 * instance). The verifier trusts this source for block headers; the report names it.
 */
import { equalBytes, fromHex, toHex, type BitcoinBlockHeader, type ChainReader } from "@docseal/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { HttpError, request, type HttpOptions } from "./http.js";

export const DEFAULT_ESPLORA_URL = "https://mempool.space/api";

const HEADER_LENGTH = 80;

export function esploraChainReader(baseUrl: string = DEFAULT_ESPLORA_URL, options: HttpOptions = {}): ChainReader {
  const base = baseUrl.replace(/\/+$/, "");
  const text = async (path: string) =>
    new TextDecoder().decode(await request(`${base}${path}`, { maxBytes: 1024 }, options)).trim();

  return {
    source: `esplora ${base}`,

    async bitcoinBlockHeader(height: number): Promise<BitcoinBlockHeader> {
      const hash = await text(`/block-height/${String(height)}`);
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        throw new HttpError(`Unexpected block hash for height ${String(height)}`);
      }
      return parseBlockHeader(fromHex(await text(`/block/${hash}/header`)), height, hash);
    },

    async bitcoinTipHeight(): Promise<number> {
      const height = Number(await text("/blocks/tip/height"));
      if (!Number.isSafeInteger(height) || height < 0) {
        throw new HttpError("Unexpected tip height");
      }
      return height;
    },
  };
}

/**
 * Parses an 80-byte header and checks it hashes to `expectedHash` (display order), so the
 * merkle root and time cannot be swapped independently of the block the source named.
 */
export function parseBlockHeader(header: Uint8Array, height: number, expectedHash: string): BitcoinBlockHeader {
  if (header.length !== HEADER_LENGTH) {
    throw new HttpError("Block header must be 80 bytes");
  }
  const hash = sha256(sha256(header)).reverse();
  if (!equalBytes(hash, fromHex(expectedHash))) {
    throw new HttpError(`Block header does not hash to ${expectedHash} (got ${toHex(hash)})`);
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return { height, merkleRoot: header.slice(36, 68), time: view.getUint32(68, true) };
}
