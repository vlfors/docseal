// The work of the verification worker, apart from the worker itself so it can be tested in Node.js.
import { esploraChainReader, firstAvailableChainReader, openTimestamps, type Fetch } from "@docseal/anchor-ots";
import {
  blobSource,
  fromHex,
  pinnedKeys,
  upgradePackageTo,
  verifyPackage,
  type AnchorFile,
  type AnchorProvider,
  type AnchorResult,
  type ByteSource,
  type ChainReader,
} from "@docseal/core";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { browserFetch } from "../network";
import { openOutput, type Output } from "../output";
import type { ChainSetting, ProofProgress, VerifyMessage, VerifyRequest } from "./protocol";

/** Progress is posted at most this often, so a fast read does not flood the page. */
export const PROGRESS_INTERVAL_MS = 100;

/** `source`, reporting how many bytes have been read through it. */
function counted(source: ByteSource, onRead: (bytes: number) => void): ByteSource {
  return {
    size: source.size,
    async read(offset, length) {
      const bytes = await source.read(offset, length);
      onRead(bytes.length);
      return bytes;
    },
  };
}

function chainReader(setting: ChainSetting, fetch: Fetch): ChainReader | undefined {
  if (setting.kind === "offline" || setting.urls.length === 0) {
    return undefined;
  }
  return firstAvailableChainReader(setting.urls.map((url) => esploraChainReader(url, { fetch })));
}

/** Orders results by how far along they are: confirmed, then deeper in the chain, then pending. */
function furthest(a: AnchorResult, b: AnchorResult): AnchorResult {
  const rank = (r: AnchorResult) => (r.verdict === "confirmed" ? 2 : r.blockHeight === undefined ? 0 : 1);
  if (rank(a) !== rank(b)) {
    return rank(a) > rank(b) ? a : b;
  }
  return (a.confirmations ?? 0) >= (b.confirmations ?? 0) ? a : b;
}

/**
 * Checks the receipts of the anchors for `seal` against the chain, as verification does: a block
 * height counts only once the proof was found in that block. Undefined if none could be checked.
 */
async function proofProgress(anchors: readonly AnchorFile[], seal: string, provider: AnchorProvider, chain: ChainReader): Promise<ProofProgress | undefined> {
  let best: AnchorResult | undefined;
  for (const anchor of anchors) {
    if (anchor.seal !== seal) {
      continue;
    }
    for (const receipt of anchor.receipts) {
      if (receipt.provider !== provider.id || receipt.digest !== seal) {
        continue;
      }
      const result = await provider.verify(receipt, fromHex(seal), chain);
      if (result.verdict === "confirmed" || result.verdict === "pending") {
        best = best ? furthest(best, result) : result;
      }
    }
  }
  if (!best) {
    return undefined;
  }
  return {
    confirmed: best.verdict === "confirmed",
    ...(best.blockHeight !== undefined && { blockHeight: best.blockHeight }),
    ...(best.confirmations !== undefined && { confirmations: best.confirmations }),
  };
}

export interface RunOptions {
  now?: () => number;
  /** The network, for tests; a browser uses browserFetch. */
  fetch?: Fetch;
}

/** Handles one request, posting progress, then exactly one report, upgrade result, or failure. */
export async function runVerification(request: VerifyRequest, post: (message: VerifyMessage) => void, options: RunOptions = {}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  // The viewer's own Esplora is the one origin beyond network.js this worker may contact.
  const ownSources = request.chain?.kind === "esplora" ? request.chain.urls.map((url) => new URL(url).origin) : [];
  const fetch = options.fetch ?? browserFetch(undefined, ownSources);
  const total = request.file.size;
  let read = 0;
  let lastPost = -Infinity;
  const source = counted(blobSource(request.file), (bytes) => {
    read = Math.min(total, read + bytes);
    if (now() - lastPost >= PROGRESS_INTERVAL_MS) {
      lastPost = now();
      post({ type: "progress", read, total });
    }
  });
  let output: Output | undefined;
  try {
    if (request.type === "verify") {
      const chain = chainReader(request.chain, fetch);
      const report = await verifyPackage(source, {
        suites: [ed25519Suite()],
        anchors: [openTimestamps({ fetch })],
        ...(chain && { chain }),
        ...(request.trustedKeys && { trust: pinnedKeys(request.trustedKeys) }),
      });
      post({ type: "report", report });
      return;
    }
    const target = request.output;
    const ots = openTimestamps({ fetch });
    const { changed, anchors } = await upgradePackageTo(
      source,
      async (didChange) => {
        if (!didChange || !target) {
          return undefined;
        }
        output = await openOutput(target);
        return output;
      },
      [ots],
    );
    const blob = await output?.close();
    const chain = request.chain && chainReader(request.chain, fetch);
    const progress = request.seal && chain ? await proofProgress(anchors, request.seal, ots, chain) : undefined;
    post({ type: "upgraded", changed, ...(output && { size: output.size() }), ...(blob && { blob }), ...(progress && { progress }) });
  } catch (error) {
    await output?.abort().catch(() => undefined);
    post({ type: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}
