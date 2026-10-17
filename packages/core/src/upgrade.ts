import { DEFAULT_LIMITS, openContainer, rewriteAnchors, type ContainerLimits } from "./container.js";
import { bytesSource, memorySink, type ByteSink, type ByteSource } from "./io.js";
import { parseJson } from "./json.js";
import { parseAnchorFile } from "./model.js";
import type { AnchorProvider } from "./plugins.js";
import { prettyJson } from "./seal.js";

export interface UpgradeResult {
  container: Uint8Array;
  /** Whether any receipt changed. */
  changed: boolean;
}

/** In-memory form of {@link upgradePackageTo}. Returns the input unchanged if nothing changed. */
export async function upgradePackage(
  zip: Uint8Array,
  providers: readonly AnchorProvider[],
  limits: ContainerLimits = DEFAULT_LIMITS,
): Promise<UpgradeResult> {
  const sink = memorySink();
  const { changed } = await upgradePackageTo(bytesSource(zip), (didChange) => (didChange ? sink : undefined), providers, limits);
  return { container: changed ? sink.bytes() : zip, changed };
}

/**
 * Asks each provider to complete its pending receipts (e.g. OpenTimestamps calendars that
 * have since committed to Bitcoin). Only anchor files change: they are outside the signed
 * state, so signatures and the seal stay valid, and every other entry is copied as is.
 *
 * `output` is called once the outcome is known and returns where to write the upgraded
 * package, or undefined to write nothing.
 */
export async function upgradePackageTo(
  input: ByteSource,
  output: (changed: boolean) => ByteSink | undefined | Promise<ByteSink | undefined>,
  providers: readonly AnchorProvider[],
  limits: ContainerLimits = DEFAULT_LIMITS,
): Promise<{ changed: boolean }> {
  const container = await openContainer(input, limits);
  const anchors = new Map<string, Uint8Array>();
  let changed = false;
  for (const [entry, bytes] of container.anchors) {
    const anchor = parseAnchorFile(parseJson(bytes));
    let anchorChanged = false;
    for (const [i, receipt] of anchor.receipts.entries()) {
      const provider = providers.find((p) => p.id === receipt.provider);
      if (!provider?.upgrade) {
        continue;
      }
      const upgraded = await provider.upgrade(receipt);
      if (upgraded.proof !== receipt.proof) {
        anchor.receipts[i] = upgraded;
        anchorChanged = true;
      }
    }
    if (anchorChanged) {
      anchors.set(entry, prettyJson(anchor));
      changed = true;
    }
  }
  const sink = await output(changed);
  if (sink) {
    await rewriteAnchors(container, anchors, sink);
  }
  return { changed };
}
