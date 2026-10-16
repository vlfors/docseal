import { DEFAULT_LIMITS, readContainer, writeContainer, type ContainerLimits } from "./container.js";
import { parseJson } from "./json.js";
import { parseAnchorFile } from "./model.js";
import type { AnchorProvider } from "./plugins.js";
import { prettyJson } from "./seal.js";

export interface UpgradeResult {
  container: Uint8Array;
  /** Whether any receipt changed. */
  changed: boolean;
}

/**
 * Asks each provider to complete its pending receipts (e.g. OpenTimestamps calendars that
 * have since committed to Bitcoin). Only anchor files change: they are outside the signed
 * state, so signatures and the seal stay valid.
 */
export async function upgradePackage(
  zip: Uint8Array,
  providers: readonly AnchorProvider[],
  limits: ContainerLimits = DEFAULT_LIMITS,
): Promise<UpgradeResult> {
  const contents = readContainer(zip, limits);
  let changed = false;
  for (const [entry, bytes] of contents.anchors) {
    const anchor = parseAnchorFile(parseJson(bytes));
    for (const [i, receipt] of anchor.receipts.entries()) {
      const provider = providers.find((p) => p.id === receipt.provider);
      if (!provider?.upgrade) {
        continue;
      }
      const upgraded = await provider.upgrade(receipt);
      if (upgraded.proof !== receipt.proof) {
        anchor.receipts[i] = upgraded;
        changed = true;
      }
    }
    contents.anchors.set(entry, prettyJson(anchor));
  }
  return { container: changed ? writeContainer(contents) : zip, changed };
}
