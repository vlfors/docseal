// The work of the verification worker, apart from the worker itself so it can be tested in Node.js.
import { esploraChainReader, firstAvailableChainReader, openTimestamps, type Fetch } from "@docseal/anchor-ots";
import { blobSource, pinnedKeys, upgradePackageTo, verifyPackage, type ByteSource, type ChainReader } from "@docseal/core";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { browserFetch } from "../network";
import { openOutput, type Output } from "../output";
import type { ChainSetting, VerifyMessage, VerifyRequest } from "./protocol";

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

export interface RunOptions {
  now?: () => number;
  /** The network, for tests; a browser uses browserFetch. */
  fetch?: Fetch;
}

/** Handles one request, posting progress, then exactly one report, upgrade result, or failure. */
export async function runVerification(request: VerifyRequest, post: (message: VerifyMessage) => void, options: RunOptions = {}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  // The viewer's own Esplora is the one origin beyond network.js this worker may contact.
  const ownSources = request.type === "verify" && request.chain.kind === "esplora" ? request.chain.urls.map((url) => new URL(url).origin) : [];
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
    const { changed } = await upgradePackageTo(
      source,
      async (didChange) => {
        if (!didChange || !target) {
          return undefined;
        }
        output = await openOutput(target);
        return output;
      },
      [openTimestamps({ fetch })],
    );
    const blob = await output?.close();
    post({ type: "upgraded", changed, ...(output && { size: output.size() }), ...(blob && { blob }) });
  } catch (error) {
    await output?.abort().catch(() => undefined);
    post({ type: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}
