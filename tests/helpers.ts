import { readFileSync } from "node:fs";
import { fromHex, type BitcoinBlockHeader, type ChainReader } from "@docseal/core";
import { parseBlockHeader, type Fetch } from "@docseal/anchor-ots";

const FIXTURES = new URL("../packages/anchor-ots/fixtures/", import.meta.url);

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

/** The recorded header of block 358391, which confirms hello-world.txt.ots. */
export function block358391(): BitcoinBlockHeader {
  const { height, hash, header } = JSON.parse(new TextDecoder().decode(fixture("bitcoin-358391.json"))) as {
    height: number;
    hash: string;
    header: string;
  };
  return parseBlockHeader(fromHex(header), height, hash);
}

/** ChainReader serving fixed headers and tip height, without network access. */
export function fakeChain(headers: readonly BitcoinBlockHeader[], tip: number): ChainReader {
  return {
    source: "test chain",
    bitcoinBlockHeader: (height) => {
      const header = headers.find((h) => h.height === height);
      return header ? Promise.resolve(header) : Promise.reject(new Error(`no block ${String(height)}`));
    },
    bitcoinTipHeight: () => Promise.resolve(tip),
  };
}

export interface FakeRequest {
  url: string;
  method: string;
  body: Uint8Array | undefined;
}

/** A fetch that records requests and answers with `respond`, or 404 when it returns undefined. */
export function fakeFetch(respond: (request: FakeRequest) => Uint8Array | undefined): Fetch & { requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const fn = (url: string, init?: RequestInit) => {
    const request: FakeRequest = {
      url,
      method: init?.method ?? "GET",
      body: init?.body instanceof Uint8Array ? init.body : undefined,
    };
    requests.push(request);
    const body = respond(request);
    return Promise.resolve(body ? new Response(body) : new Response("not found", { status: 404 }));
  };
  return Object.assign(fn, { requests });
}
