/**
 * One fake network for calendars and Esplora, for tests across the repository: any calendar
 * accepts a submission with a pending proof from CALENDAR_URI; after `confirm()`, that calendar
 * returns a Bitcoin attestation, and the Esplora instance at https://esplora.test serves a block
 * whose merkle root is that commitment.
 */
import { serializeTimestamp, type Fetch } from "@docseal/anchor-ots";
import { fromHex, hash, toHex } from "@docseal/core";

export const CALENDAR_URI = "https://alice.btc.calendar.opentimestamps.org";
export const HEIGHT = 900_000;
export const BLOCK_TIME = 1_750_000_000;

export function fakeNetwork() {
  let confirmed = false;
  let block: { hash: string; header: Uint8Array } | undefined;
  const requests: string[] = [];
  const fetch: Fetch = (url, init) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);
    const reply = (body: Uint8Array | string | undefined) =>
      Promise.resolve(
        body === undefined
          ? new Response("not found", { status: 404 })
          : new Response(typeof body === "string" ? body : new Uint8Array(body)),
      );
    if (init?.method === "POST" && url.endsWith("/digest") && init.body instanceof Uint8Array) {
      return reply(serializeTimestamp({ msg: init.body, attestations: [{ kind: "pending", uri: CALENDAR_URI }], ops: [] }));
    }
    const commitment = /^https:\/\/alice\.btc\.calendar\.opentimestamps\.org\/timestamp\/([0-9a-f]{64})$/.exec(url)?.[1];
    if (commitment && confirmed) {
      const header = new Uint8Array(80);
      header.set(fromHex(commitment), 36);
      new DataView(header.buffer).setUint32(68, BLOCK_TIME, true);
      block = { header, hash: toHex(hash(hash(header)).reverse()) };
      return reply(serializeTimestamp({ msg: fromHex(commitment), attestations: [{ kind: "bitcoin", height: HEIGHT }], ops: [] }));
    }
    if (url === "https://esplora.test/blocks/tip/height") return reply(String(HEIGHT + 9));
    if (url === `https://esplora.test/block-height/${String(HEIGHT)}`) return reply(block?.hash);
    if (block && url === `https://esplora.test/block/${block.hash}/header`) return reply(toHex(block.header));
    return reply(undefined);
  };
  return {
    fetch,
    requests,
    confirm: () => {
      confirmed = true;
    },
  };
}

