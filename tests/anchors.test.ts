/**
 * End to end with anchoring: seal → pending → upgrade → confirmed → overall valid,
 * using a fake calendar and chain so the test is offline and deterministic.
 */
import {
  DocSeal,
  fromHex,
  parseJson,
  pinnedKeys,
  readContainer,
  utf8,
  writeContainer,
  type AnchorFile,
  type AnchorProvider,
  type BitcoinBlockHeader,
  type PackageContents,
  type TrustPolicy,
} from "@docseal/core";
import { openTimestamps, serializeTimestamp, type Timestamp } from "@docseal/anchor-ots";
import { ed25519Suite, generateSecretKey, memoryKeyProvider } from "@docseal/sig-ed25519";
import { describe, expect, it } from "vitest";
import { fakeChain, fakeFetch } from "./helpers.js";

const CALENDAR = "https://alice.btc.calendar.opentimestamps.org";
const HEIGHT = 900_000;
const BLOCK_TIME = 1_750_000_000;

/**
 * Plays the calendar: answers a submission with a pending attestation and, once
 * `confirm()` was called, the upgrade with a Bitcoin attestation for HEIGHT.
 */
function calendar() {
  const headers: BitcoinBlockHeader[] = [];
  let confirmed = false;
  const fetch = fakeFetch(({ method, url, body }) => {
    if (method === "POST" && body) {
      const pending: Timestamp = { msg: body, attestations: [{ kind: "pending", uri: CALENDAR }], ops: [] };
      return serializeTimestamp(pending);
    }
    const match = /\/timestamp\/([0-9a-f]{64})$/.exec(url);
    if (!confirmed || !match?.[1]) {
      return undefined;
    }
    const commitment = fromHex(match[1]);
    // The block's merkle root is exactly the committed digest: the shortest valid proof.
    headers.push({ height: HEIGHT, merkleRoot: commitment, time: BLOCK_TIME });
    return serializeTimestamp({ msg: commitment, attestations: [{ kind: "bitcoin", height: HEIGHT }], ops: [] });
  });
  return {
    fetch,
    confirm: () => {
      confirmed = true;
    },
    chain: (tip = HEIGHT + 5) => fakeChain(headers, tip),
  };
}

async function setup() {
  const cal = calendar();
  const signer = memoryKeyProvider(generateSecretKey());
  const docseal = new DocSeal({
    signatures: [ed25519Suite()],
    anchors: [openTimestamps({ calendars: ["https://pool.test"], fetch: cal.fetch })],
    trust: pinnedKeys([await signer.getSigner()]),
    chain: cal.chain(),
  });
  const sealed = await docseal.seal({
    files: [
      { path: "contract.pdf", data: utf8("%PDF contract") },
      { path: "annex.txt", data: utf8("annex") },
    ],
    signer,
  });
  return { cal, signer, docseal, sealed };
}

function anchorOf(contents: PackageContents): AnchorFile {
  return parseJson(contents.anchors.get("anchors/seal-1.json") ?? new Uint8Array()) as AnchorFile;
}

describe("anchoring", () => {
  it("goes from pending to fully valid after upgrade", async () => {
    const { cal, docseal, sealed } = await setup();
    expect(sealed.anchor?.seal).toBe(sealed.seal);

    const pending = await docseal.verify(sealed.container);
    expect(pending.axes.time).toBe("pending");
    expect(pending.axes.completeness).toBe("full");
    expect(pending.overall).toBe("indeterminate");

    // Nothing to upgrade before the calendar commits to Bitcoin.
    expect((await docseal.upgrade(sealed.container)).changed).toBe(false);

    cal.confirm();
    const upgraded = await docseal.upgrade(sealed.container);
    expect(upgraded.changed).toBe(true);

    const report = await docseal.verify(upgraded.container, { chain: cal.chain() });
    expect(report.axes).toEqual({
      format: "valid",
      integrity: "valid",
      signature: "valid",
      trust: "trusted",
      time: "confirmed",
      completeness: "full",
    });
    expect(report.overall).toBe("valid");
    expect(report.attestedAt).toBe(new Date(BLOCK_TIME * 1000).toISOString());
    expect(report.anchors).toEqual([
      expect.objectContaining({ verdict: "confirmed", confirmations: 6, source: "test chain" }),
    ]);
  });

  it("passes the proven time, not the claimed one, to the trust policy", async () => {
    const { cal, docseal, sealed, signer } = await setup();
    cal.confirm();
    const { container } = await docseal.upgrade(sealed.container);
    const seen: (Date | null)[] = [];
    const recording: TrustPolicy = {
      id: "recording",
      evaluate: async (id, context) => {
        seen.push(context.attestedAt);
        return id === (await signer.getSigner()) ? { verdict: "trusted" } : { verdict: "untrusted" };
      },
    };
    await docseal.verify(container, { trust: recording, chain: cal.chain() });
    expect(seen).toEqual([new Date(BLOCK_TIME * 1000)]);
  });

  it("does not count a confirmation that is too shallow", async () => {
    const { cal, docseal, sealed } = await setup();
    cal.confirm();
    const { container } = await docseal.upgrade(sealed.container);
    const report = await docseal.verify(container, { chain: cal.chain(HEIGHT + 1) });
    expect(report.axes.time).toBe("pending");
    expect(report.overall).toBe("indeterminate");
  });

  it("rejects an anchor moved from another package", async () => {
    const first = await setup();
    const second = await setup();
    const contents = readContainer(second.sealed.container);
    const foreign = readContainer(first.sealed.container).anchors.get("anchors/seal-1.json");
    if (!foreign) throw new Error("missing anchor");
    contents.anchors.set("anchors/seal-1.json", foreign);
    const report = await second.docseal.verify(writeContainer(contents));
    expect(report.axes.time).toBe("invalid");
    expect(report.overall).toBe("invalid");
  });

  it("rejects an anchor whose envelope list or seal was edited", async () => {
    const { docseal, sealed } = await setup();
    for (const edit of [
      (a: AnchorFile) => {
        a.envelopes = ["00".repeat(32)];
      },
      (a: AnchorFile) => {
        a.seal = "11".repeat(32);
      },
      (a: AnchorFile) => {
        const [receipt] = a.receipts;
        if (receipt) receipt.digest = "22".repeat(32);
      },
    ]) {
      const contents = readContainer(sealed.container);
      const anchor = anchorOf(contents);
      edit(anchor);
      contents.anchors.set("anchors/seal-1.json", utf8(JSON.stringify(anchor)));
      expect((await docseal.verify(writeContainer(contents))).axes.time).toBe("invalid");
    }
  });

  it("binds the anchor to the package itself, even with a provider that accepts anything", async () => {
    const { docseal, sealed, cal } = await setup();
    const lax: AnchorProvider = {
      id: "opentimestamps",
      submit: () => Promise.reject(new Error("unused")),
      verify: () => Promise.resolve({ verdict: "confirmed", attestedAt: new Date(0), confirmations: 100 }),
    };
    const verifier = new DocSeal({ signatures: docseal.signatures, anchors: [lax], chain: cal.chain() });
    expect((await verifier.verify(sealed.container)).axes.time).toBe("confirmed");

    for (const edit of [
      (a: AnchorFile) => {
        // Consistent forgery: seal and receipt agree with each other, not with the package.
        a.seal = "11".repeat(32);
        for (const r of a.receipts) r.digest = a.seal;
      },
      (a: AnchorFile) => {
        for (const r of a.receipts) r.digest = "22".repeat(32);
      },
    ]) {
      const contents = readContainer(sealed.container);
      const anchor = anchorOf(contents);
      edit(anchor);
      contents.anchors.set("anchors/seal-1.json", utf8(JSON.stringify(anchor)));
      expect((await verifier.verify(writeContainer(contents))).axes.time).toBe("invalid");
    }
  });

  it("invalidates the anchor when a signature is added afterwards", async () => {
    const { docseal, sealed } = await setup();
    const contents = readContainer(sealed.container);
    const envelope = contents.signatures.get("signatures/0001.json");
    if (!envelope) throw new Error("missing");
    const copy = parseJson(envelope) as { protected: { role?: string } };
    copy.protected.role = "witness"; // breaks this signature, but the point is the seal no longer covers the set
    contents.signatures.set("signatures/0002.json", utf8(JSON.stringify(copy)));
    const report = await docseal.verify(writeContainer(contents));
    expect(report.axes.time).toBe("invalid");
  });

  it("reports anchors as unsupported without a chain source or provider", async () => {
    const { docseal, sealed, cal } = await setup();
    cal.confirm();
    const { container } = await docseal.upgrade(sealed.container);
    const noChain = new DocSeal({ signatures: docseal.signatures, anchors: docseal.anchors });
    const withoutChain = await noChain.verify(container);
    expect(withoutChain.axes.time).toBe("unsupported");
    expect(withoutChain.axes.completeness).toBe("incomplete");

    const noProvider = new DocSeal({ signatures: docseal.signatures, chain: cal.chain() });
    expect((await noProvider.verify(container)).axes.time).toBe("unsupported");
  });

  it("seals without anchoring when asked", async () => {
    const { docseal, signer } = await setup();
    const result = await docseal.seal({ files: [{ path: "a.txt", data: utf8("a") }], signer, anchor: false });
    expect(result.anchor).toBeUndefined();
    expect((await docseal.verify(result.container)).axes.time).toBe("missing");
  });
});
