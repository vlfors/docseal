// The work of the verification worker, apart from the worker itself so it can be tested in Node.js.
import { blobSource, pinnedKeys, verifyPackage, type ByteSource } from "@docseal/core";
import { openTimestamps } from "@docseal/anchor-ots";
import { ed25519Suite } from "@docseal/sig-ed25519";
import type { VerifyMessage, VerifyRequest } from "./protocol";

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

/** Verifies `request.file` offline and posts progress, then exactly one report or failure. */
export async function runVerification(request: VerifyRequest, post: (message: VerifyMessage) => void, now: () => number = () => performance.now()): Promise<void> {
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
  try {
    const report = await verifyPackage(source, {
      suites: [ed25519Suite()],
      anchors: [openTimestamps()],
      ...(request.trustedKeys && { trust: pinnedKeys(request.trustedKeys) }),
    });
    post({ type: "report", report });
  } catch (error) {
    post({ type: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}
