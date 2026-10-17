/** OpenTimestamps provider: submit, upgrade, and verify, with network and chain replaced by fakes. */
import { hash, toBase64url, toHex, type AnchorReceipt, type ChainReader } from "@docseal/core";
import {
  BITCOIN_MAINNET,
  attestations,
  esploraChainReader,
  isAllowed,
  openTimestamps,
  parseDetached,
  serializeDetached,
  serializeTimestamp,
  type Fetch,
  type Timestamp,
} from "@docseal/anchor-ots";
import { describe, expect, it } from "vitest";
import { block358391, fakeChain, fakeFetch, fixture } from "./helpers.js";

const HELLO_DIGEST = hash(fixture("hello-world.txt"));
const TIP = 971_754;

function receiptFor(name: string, digest: Uint8Array): AnchorReceipt {
  return {
    provider: "opentimestamps",
    network: BITCOIN_MAINNET,
    digestAlgorithm: "sha-256",
    digest: toHex(digest),
    proof: toBase64url(fixture(`${name}.txt.ots`)),
  };
}

const offline = openTimestamps({ calendars: [], fetch: fakeFetch(() => undefined) });

describe("verify", () => {
  const chain = fakeChain([block358391()], TIP);

  it("confirms hello-world against the real block 358391", async () => {
    const result = await offline.verify(receiptFor("hello-world", HELLO_DIGEST), HELLO_DIGEST, chain);
    expect(result).toEqual({
      verdict: "confirmed",
      attestedAt: new Date("2015-05-28T15:41:18Z"),
      confirmations: TIP - 358391 + 1,
      source: "test chain",
    });
  });

  it("rejects a proof whose path does not lead to the block's merkle root", async () => {
    const digest = hash(fixture("bad-stamp.txt"));
    const result = await offline.verify(receiptFor("bad-stamp", digest), digest, chain);
    expect(result.verdict).toBe("invalid");
  });

  it("rejects a proof for a different digest", async () => {
    const other = hash(new Uint8Array([1]));
    expect((await offline.verify(receiptFor("hello-world", HELLO_DIGEST), other, chain)).verdict).toBe("invalid");
    const lying = { ...receiptFor("hello-world", HELLO_DIGEST), digest: toHex(other) };
    expect((await offline.verify(lying, HELLO_DIGEST, chain)).verdict).toBe("invalid");
  });

  it("reports a proof with only calendar promises as pending", async () => {
    const digest = hash(fixture("incomplete.txt"));
    expect((await offline.verify(receiptFor("incomplete", digest), digest, chain)).verdict).toBe("pending");
  });

  it("reports a proof with only unknown notaries as unsupported", async () => {
    const digest = hash(fixture("unknown-notary.txt"));
    expect((await offline.verify(receiptFor("unknown-notary", digest), digest, chain)).verdict).toBe("unsupported");
  });

  it("treats too few confirmations as pending", async () => {
    const shallow = fakeChain([block358391()], 358391 + 2);
    const result = await offline.verify(receiptFor("hello-world", HELLO_DIGEST), HELLO_DIGEST, shallow);
    expect(result).toMatchObject({ verdict: "pending", confirmations: 3 });
  });

  it("does not treat an unreachable or incapable chain source as a result", async () => {
    const broken: ChainReader = {
      source: "broken",
      bitcoinBlockHeader: () => Promise.reject(new Error("timeout")),
      bitcoinTipHeight: () => Promise.resolve(TIP),
    };
    expect((await offline.verify(receiptFor("hello-world", HELLO_DIGEST), HELLO_DIGEST, broken)).verdict).toBe("unsupported");
    const none: ChainReader = { source: "none" };
    expect((await offline.verify(receiptFor("hello-world", HELLO_DIGEST), HELLO_DIGEST, none)).verdict).toBe("unsupported");
  });

  it("checks repeated identical attestations once, and refuses proofs with many distinct ones", async () => {
    const digest = hash(new Uint8Array([3]));
    const header = { height: 800_000, merkleRoot: digest, time: 1_700_000_000 };
    let calls = 0;
    const counting: ChainReader = {
      source: "counting",
      bitcoinBlockHeader: () => {
        calls++;
        return Promise.resolve(header);
      },
      bitcoinTipHeight: () => Promise.resolve(800_100),
    };
    const repeated: Timestamp = {
      msg: digest,
      attestations: Array.from({ length: 5000 }, () => ({ kind: "bitcoin" as const, height: 800_000 })),
      ops: [],
    };
    const receipt = (timestamp: Timestamp): AnchorReceipt => ({
      provider: "opentimestamps",
      network: BITCOIN_MAINNET,
      digestAlgorithm: "sha-256",
      digest: toHex(digest),
      proof: toBase64url(serializeDetached({ hashOp: "sha256", timestamp })),
    });
    expect((await offline.verify(receipt(repeated), digest, counting)).verdict).toBe("confirmed");
    expect(calls).toBe(1);

    const many: Timestamp = {
      msg: digest,
      attestations: Array.from({ length: 9 }, (_, i) => ({ kind: "bitcoin" as const, height: 800_000 + i })),
      ops: [],
    };
    expect((await offline.verify(receipt(many), digest, counting)).verdict).toBe("invalid");
  });

  it("rejects other networks and malformed proofs", async () => {
    const litecoin = { ...receiptFor("hello-world", HELLO_DIGEST), network: "bip122:12a765e31ffd4059bada1e25190f6e98" };
    expect((await offline.verify(litecoin, HELLO_DIGEST, chain)).verdict).toBe("unsupported");
    const garbage = { ...receiptFor("hello-world", HELLO_DIGEST), proof: "AAAA" };
    expect((await offline.verify(garbage, HELLO_DIGEST, chain)).verdict).toBe("invalid");
  });
});

/** A calendar answer: digest → append(nonce) → sha256 → pending attestation for `uri`. */
function pendingResponse(digest: Uint8Array, nonce: number, uri: string): { body: Uint8Array; commitment: Uint8Array } {
  const commitment = hash(digest, Uint8Array.of(nonce));
  const timestamp: Timestamp = {
    msg: digest,
    attestations: [],
    ops: [
      {
        op: { kind: "append", arg: Uint8Array.of(nonce) },
        next: {
          msg: new Uint8Array([...digest, nonce]),
          attestations: [],
          ops: [{ op: { kind: "sha256" }, next: { msg: commitment, attestations: [{ kind: "pending", uri }], ops: [] } }],
        },
      },
    ],
  };
  return { body: serializeTimestamp(timestamp), commitment };
}

describe("submit", () => {
  const digest = hash(new Uint8Array([42]));

  it("posts the digest to every calendar and merges the answers", async () => {
    const fetch = fakeFetch(({ url, body }) => {
      expect(body).toEqual(digest);
      return url.startsWith("https://one")
        ? pendingResponse(digest, 1, "https://alice.btc.calendar.opentimestamps.org").body
        : pendingResponse(digest, 2, "https://bob.btc.calendar.opentimestamps.org").body;
    });
    const provider = openTimestamps({ calendars: ["https://one", "https://two/"], fetch });
    const receipt = await provider.submit(digest);
    expect(fetch.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST https://one/digest", "POST https://two/digest"]);
    expect(receipt).toMatchObject({ provider: "opentimestamps", digest: toHex(digest), cached: { status: "pending" } });
    const uris = attestations(parseDetached(new Uint8Array(Buffer.from(receipt.proof, "base64url"))).timestamp).map(
      ({ attestation }) => (attestation.kind === "pending" ? attestation.uri : ""),
    );
    expect(uris.sort()).toEqual(["https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org"]);
  });

  it("fails when fewer calendars than required accept the digest", async () => {
    const fetch = fakeFetch(({ url }) =>
      url.startsWith("https://one") ? pendingResponse(digest, 1, "https://a.calendar.opentimestamps.org").body : undefined,
    );
    const provider = openTimestamps({ calendars: ["https://one", "https://two"], fetch });
    await expect(provider.submit(digest)).rejects.toThrow(/Only 1 of 2 calendars/);
  });

  it("does not accept a calendar answer for a different digest", async () => {
    const fetch = fakeFetch(() => Uint8Array.of(0xaa));
    const provider = openTimestamps({ calendars: ["https://one"], fetch });
    await expect(provider.submit(digest)).rejects.toThrow(/calendars accepted/);
  });
});

describe("upgrade", () => {
  const digest = hash(new Uint8Array([7]));
  const uri = "https://alice.btc.calendar.opentimestamps.org";

  async function pendingReceipt(calendarUri: string): Promise<{ receipt: AnchorReceipt; commitment: Uint8Array }> {
    const { body, commitment } = pendingResponse(digest, 9, calendarUri);
    const provider = openTimestamps({ calendars: ["https://pool"], fetch: fakeFetch(() => body) });
    return { receipt: await provider.submit(digest), commitment };
  }

  it("fetches the completed timestamp from an allowed calendar and merges it", async () => {
    const { receipt, commitment } = await pendingReceipt(uri);
    const completed = serializeTimestamp({ msg: commitment, attestations: [{ kind: "bitcoin", height: 900_000 }], ops: [] });
    const fetch = fakeFetch(({ url }) => (url === `${uri}/timestamp/${toHex(commitment)}` ? completed : undefined));
    const upgraded = await openTimestamps({ fetch }).upgrade?.(receipt);
    expect(upgraded?.cached).toMatchObject({ status: "confirmed", blockHeight: 900_000, submittedAt: receipt.cached?.submittedAt });

    const chain = fakeChain([{ height: 900_000, merkleRoot: commitment, time: 1_750_000_000 }], 900_010);
    const result = await openTimestamps().verify(upgraded ?? receipt, digest, chain);
    expect(result).toMatchObject({ verdict: "confirmed", confirmations: 11 });
  });

  it("leaves the receipt unchanged while the calendar has nothing yet", async () => {
    const { receipt } = await pendingReceipt(uri);
    const upgraded = await openTimestamps({ fetch: fakeFetch(() => undefined) }).upgrade?.(receipt);
    expect(upgraded?.proof).toBe(receipt.proof);
  });

  it("never contacts a calendar URL that is not allow-listed", async () => {
    const { receipt } = await pendingReceipt("https://attacker.example");
    const fetch = fakeFetch(() => undefined);
    await openTimestamps({ fetch }).upgrade?.(receipt);
    expect(fetch.requests).toEqual([]);
  });
});

describe("HTTP", () => {
  it("refuses redirects and stops reading oversized responses", async () => {
    const inits: (RequestInit | undefined)[] = [];
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const fetch: Fetch = (_, init) => {
      inits.push(init);
      return Promise.resolve(new Response(endless));
    };
    const chain = esploraChainReader("https://esplora.test", { fetch });
    await expect(chain.bitcoinTipHeight?.()).rejects.toThrow(/larger than 1024 bytes/);
    expect(inits[0]?.redirect).toBe("error");
    expect(pulled).toBeLessThan(5);
  });
});

describe("isAllowed", () => {
  const patterns = ["https://*.calendar.opentimestamps.org", "https://exact.example"];

  it.each([
    ["https://alice.btc.calendar.opentimestamps.org", true],
    ["https://exact.example", true],
    ["https://calendar.opentimestamps.org", false],
    ["https://evilcalendar.opentimestamps.org", false],
    ["http://alice.btc.calendar.opentimestamps.org", false],
    ["https://alice.btc.calendar.opentimestamps.org:8443", false],
    ["https://user@exact.example", false],
    ["https://exact.example/path", false],
    ["https://exact.example.evil", false],
    ["not a url", false],
  ])("%s → %s", (uri, expected) => {
    expect(isAllowed(uri, patterns)).toBe(expected);
  });
});

describe("esploraChainReader", () => {
  const { header, hash: blockHash } = JSON.parse(new TextDecoder().decode(fixture("bitcoin-358391.json"))) as {
    header: string;
    hash: string;
  };

  it("reads a header by height and checks it hashes to the named block", async () => {
    const fetch = fakeFetch(({ url }) => {
      const routes: Record<string, string> = {
        "https://esplora.test/api/block-height/358391": blockHash,
        [`https://esplora.test/api/block/${blockHash}/header`]: header,
        "https://esplora.test/api/blocks/tip/height": String(TIP),
      };
      const body = routes[url];
      return body === undefined ? undefined : new TextEncoder().encode(body);
    });
    const chain = esploraChainReader("https://esplora.test/api/", { fetch });
    expect(chain.source).toBe("esplora https://esplora.test/api");
    await expect(chain.bitcoinTipHeight?.()).resolves.toBe(TIP);
    const parsed = await chain.bitcoinBlockHeader?.(358391);
    expect(parsed?.time).toBe(1432827678);
    expect(toHex(parsed?.merkleRoot ?? new Uint8Array())).toBe(toHex(block358391().merkleRoot));
  });

  it("rejects a header that does not hash to the block the source named", async () => {
    const forged = header.replace(/^02/, "03");
    const fetch = fakeFetch(({ url }) =>
      new TextEncoder().encode(url.includes("block-height") ? blockHash : forged),
    );
    await expect(esploraChainReader("https://esplora.test", { fetch }).bitcoinBlockHeader?.(358391)).rejects.toThrow(
      /does not hash/,
    );
  });
});
