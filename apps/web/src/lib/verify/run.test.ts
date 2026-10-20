import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Fetch } from "@docseal/anchor-ots";
import type { TrustedKey } from "@docseal/core";
import { fakeNetwork } from "../../../../../tests/fake-network";
import { Signer } from "../signer/run";
import type { VerifyMessage } from "./protocol";
import { PROGRESS_INTERVAL_MS, runVerification } from "./run";

const PACKAGES = new URL("../../../../../spec/vectors/packages/", import.meta.url);
const golden = (name: string) => new Blob([readFileSync(new URL(name, PACKAGES))]);

/** Offline, a verification must not touch the network at all. */
const noNetwork: Fetch = (url) => Promise.reject(new Error(`unexpected request to ${url}`));

async function run(request: { file: Blob; trustedKeys?: readonly TrustedKey[] }, now?: () => number): Promise<VerifyMessage[]> {
  const messages: VerifyMessage[] = [];
  await runVerification({ type: "verify", chain: { kind: "offline" }, ...request }, (message) => messages.push(message), {
    fetch: noNetwork,
    ...(now && { now }),
  });
  return messages;
}

function reportOf(messages: VerifyMessage[]) {
  const last = messages.at(-1);
  if (last?.type !== "report") {
    throw new Error(`expected a report, got ${JSON.stringify(last)}`);
  }
  return last.report;
}

describe("runVerification", () => {
  it("gives every golden package the verdicts its vector requires", async () => {
    const expected = JSON.parse(readFileSync(new URL("expected.json", PACKAGES), "utf8")) as {
      packages: { file: string; expected: unknown }[];
    };
    for (const { file, expected: verdict } of expected.packages) {
      const report = reportOf(await run({ file: golden(file) }));
      expect({ axes: report.axes, overall: report.overall }, file).toEqual(verdict);
    }
  });

  it("evaluates trust only when given a list of keys", async () => {
    const file = golden("valid-basic.dseal");
    const untrusted = reportOf(await run({ file }));
    expect(untrusted.axes.trust).toBe("not-evaluated");
    const signer = untrusted.signatures[0]?.signer ?? "";
    expect(reportOf(await run({ file, trustedKeys: [{ id: signer, label: "Author" }] })).axes.trust).toBe("trusted");
    expect(reportOf(await run({ file, trustedKeys: [] })).axes.trust).toBe("untrusted");
  });

  it("posts progress that grows up to the size of the package, then one report", async () => {
    const file = golden("valid-basic.dseal");
    // A clock that moves past the interval on every read, so every read is posted.
    let time = 0;
    const messages = await run({ file }, () => (time += PROGRESS_INTERVAL_MS));
    const progress = messages.filter((message) => message.type === "progress");
    expect(progress.length).toBeGreaterThan(1);
    for (const [i, message] of progress.entries()) {
      expect(message.total).toBe(file.size);
      expect(message.read).toBeLessThanOrEqual(file.size);
      expect(message.read).toBeGreaterThanOrEqual(progress[i - 1]?.read ?? 0);
    }
    expect(messages.filter((message) => message.type !== "progress").map((message) => message.type)).toEqual(["report"]);
  });

  it("posts progress at most once per interval", async () => {
    const messages = await run({ file: golden("valid-basic.dseal") }, () => 0);
    expect(messages.filter((message) => message.type === "progress")).toHaveLength(1);
  });

  it("reports a package it cannot read as a failure, not a verdict", async () => {
    const unreadable = {
      size: 1000,
      slice: () => ({ arrayBuffer: () => Promise.reject(new DOMException("The file was removed", "NotReadableError")) }),
    } as unknown as Blob;
    const messages = await run({ file: unreadable });
    expect(messages.at(-1)).toEqual({ type: "failed", message: "The file was removed" });
  });

  it("reports a trusted-key list that names a key twice as a failure", async () => {
    const messages = await run({ file: golden("valid-basic.dseal"), trustedKeys: [{ id: "did:key:z1" }, { id: "did:key:z1" }] });
    expect(messages.at(-1)).toEqual({ type: "failed", message: "Key did:key:z1 is listed twice" });
  });

  it("seals with a time proof, upgrades it once Bitcoin confirms, and then verifies as valid", async () => {
    const network = fakeNetwork();
    const messages: unknown[] = [];
    const signer = new Signer((m) => messages.push(m), () => 0, 2 ** 10, network.fetch);
    await signer.handle({ type: "generate", passphrase: "correct horse battery" });
    const did = (messages.at(-1) as { did: string }).did;
    await signer.handle({
      type: "seal",
      files: [{ path: "a.txt", file: new File(["document"], "a.txt") }],
      role: "author",
      output: { kind: "memory", limit: 1024 * 1024 },
      timestamp: true,
    });
    const sealed = messages.at(-1) as { type: string; blob: Blob; calendars: string[] };
    expect(sealed.type).toBe("sealed");
    // Every calendar a browser can reach accepted it (the fake accepts any).
    expect(sealed.calendars).toHaveLength(3);

    const online = { kind: "esplora", urls: ["https://unreachable.test", "https://esplora.test"] } as const;
    const verify = async (file: Blob) => {
      const out: VerifyMessage[] = [];
      await runVerification({ type: "verify", file, chain: online, trustedKeys: [{ id: did }] }, (m) => out.push(m), { fetch: network.fetch });
      return reportOf(out);
    };
    const upgrade = async (file: Blob, save: boolean) => {
      const out: VerifyMessage[] = [];
      await runVerification({ type: "upgrade", file, ...(save && { output: { kind: "memory", limit: 1024 * 1024 } }) }, (m) => out.push(m), {
        fetch: network.fetch,
      });
      return out.at(-1) as Extract<VerifyMessage, { type: "upgraded" }>;
    };

    expect((await verify(sealed.blob)).axes.time).toBe("pending");
    expect(await upgrade(sealed.blob, false)).toEqual({ type: "upgraded", changed: false });
    network.confirm();
    expect(await upgrade(sealed.blob, false)).toEqual({ type: "upgraded", changed: true });
    const saved = await upgrade(sealed.blob, true);
    expect(saved).toMatchObject({ changed: true });
    const report = await verify(saved.blob ?? new Blob());
    expect(report.overall).toBe("valid");
    // The source that answered is named; the unreachable one was skipped.
    expect(report.anchors[0]?.source).toBe("esplora https://esplora.test");
  });
});
