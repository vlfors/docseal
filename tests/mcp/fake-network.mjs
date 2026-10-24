/**
 * Preloaded into the built docseal-mcp (`node --import`), so the end-to-end tests run the real
 * binary without the real network: global fetch becomes the fake network of
 * tests/fake-network.ts. Its state lives in DOCSEAL_TEST_NETWORK, a directory shared with the
 * test: the file `confirmed` makes calendars return Bitcoin attestations, and the block they
 * commit to is written to `block.json` for the fake Esplora at https://esplora.test. Every
 * request is appended to `requests.log`.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeTimestamp } from "@docseal/anchor-ots";
import { fromHex, hash, toHex } from "@docseal/core";

const STATE = process.env.DOCSEAL_TEST_NETWORK;
if (!STATE) throw new Error("DOCSEAL_TEST_NETWORK is not set");
const CALENDAR_URI = "https://alice.btc.calendar.opentimestamps.org";
const HEIGHT = 900_000;
const BLOCK_TIME = 1_750_000_000;

const reply = (body) => Promise.resolve(body === undefined ? new Response("not found", { status: 404 }) : new Response(body));
const block = () => (existsSync(join(STATE, "block.json")) ? JSON.parse(readFileSync(join(STATE, "block.json"), "utf8")) : undefined);

globalThis.fetch = (url, init) => {
  appendFileSync(join(STATE, "requests.log"), `${init?.method ?? "GET"} ${String(url)}\n`);
  if (init?.method === "POST" && String(url).endsWith("/digest") && init.body instanceof Uint8Array) {
    return reply(serializeTimestamp({ msg: init.body, attestations: [{ kind: "pending", uri: CALENDAR_URI }], ops: [] }));
  }
  const commitment = /^https:\/\/alice\.btc\.calendar\.opentimestamps\.org\/timestamp\/([0-9a-f]{64})$/.exec(String(url))?.[1];
  if (commitment && existsSync(join(STATE, "confirmed"))) {
    const header = new Uint8Array(80);
    header.set(fromHex(commitment), 36);
    new DataView(header.buffer).setUint32(68, BLOCK_TIME, true);
    writeFileSync(join(STATE, "block.json"), JSON.stringify({ hash: toHex(hash(hash(header)).reverse()), header: toHex(header) }));
    return reply(serializeTimestamp({ msg: fromHex(commitment), attestations: [{ kind: "bitcoin", height: HEIGHT }], ops: [] }));
  }
  if (url === "https://esplora.test/blocks/tip/height") return reply(String(HEIGHT + 9));
  if (url === `https://esplora.test/block-height/${String(HEIGHT)}`) return reply(block()?.hash);
  if (block() && url === `https://esplora.test/block/${block().hash}/header`) return reply(block().header);
  return reply(undefined);
};
