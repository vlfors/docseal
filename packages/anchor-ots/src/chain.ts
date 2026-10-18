/**
 * A ChainReader over several sources, used in turn: a source that fails (unreachable, an HTTP
 * error, or an answer that does not check out) is skipped for the next one. Every source is
 * trusted the same way, so falling back is no weaker than relying on any one of them.
 */
import type { BitcoinBlockHeader, ChainReader } from "@docseal/core";

export function firstAvailableChainReader(readers: readonly ChainReader[]): ChainReader {
  if (readers.length === 0) {
    throw new RangeError("At least one chain source is required");
  }
  // The source that answered last is asked first, so an unreachable one costs its timeout once.
  let current = 0;
  const used: string[] = [];

  async function ask<T>(call: (reader: ChainReader) => Promise<T> | undefined): Promise<T> {
    const failures: string[] = [];
    for (let i = 0; i < readers.length; i++) {
      const index = (current + i) % readers.length;
      const reader = readers[index] as ChainReader;
      const pending = call(reader);
      if (!pending) {
        failures.push(`${reader.source}: cannot read Bitcoin headers`);
        continue;
      }
      try {
        const result = await pending;
        current = index;
        if (!used.includes(reader.source)) {
          used.push(reader.source);
        }
        return result;
      } catch (error) {
        failures.push(`${reader.source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(failures.join("; "));
  }

  return {
    /** The sources that answered, or all of them while none has. */
    get source() {
      return (used.length > 0 ? used : readers.map((reader) => reader.source)).join(", ");
    },
    bitcoinBlockHeader: (height: number): Promise<BitcoinBlockHeader> => ask((reader) => reader.bitcoinBlockHeader?.(height)),
    bitcoinTipHeight: (): Promise<number> => ask((reader) => reader.bitcoinTipHeight?.()),
  };
}
