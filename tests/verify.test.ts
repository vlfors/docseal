/**
 * Verification paths the golden packages cannot reach offline: trust policies, several
 * anchor receipts and providers, and a source that fails to read.
 */
import { readFileSync } from "node:fs";
import {
  bytesSource,
  openContainer,
  parseJson,
  readContainer,
  utf8,
  verifyPackage,
  writeContainer,
  type AnchorFile,
  type AnchorProvider,
  type AnchorResult,
  type ByteSource,
  type TrustPolicy,
  type TrustResult,
} from "@docseal/core";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { describe, expect, it } from "vitest";

const PACKAGES = new URL("../spec/vectors/packages/", import.meta.url);
const golden = (file: string) => new Uint8Array(readFileSync(new URL(file, PACKAGES)));
const chain = { source: "test chain" };

/** A provider that answers every receipt with `result`. */
const provider = (id: string, result: AnchorResult): AnchorProvider => ({
  id,
  submit: () => Promise.reject(new Error("not used")),
  verify: () => Promise.resolve(result),
});

/** The pending-anchor golden package with its one receipt replaced by one per provider id. */
async function withReceipts(providers: string[]): Promise<Uint8Array> {
  const contents = await readContainer(golden("valid-pending-anchor.dseal"));
  const anchor = parseJson(contents.anchors.get("anchors/seal-1.json") ?? new Uint8Array()) as AnchorFile;
  const [receipt] = anchor.receipts;
  anchor.receipts = providers.map((id) => ({ ...receipt, provider: id }) as AnchorFile["receipts"][number]);
  contents.anchors.set("anchors/seal-1.json", utf8(JSON.stringify(anchor)));
  return writeContainer(contents);
}

describe("anchors", () => {
  const EARLY = new Date("2026-03-01T00:00:00Z");
  const MIDDLE = new Date("2026-03-02T00:00:00Z");
  const LATE = new Date("2026-03-03T00:00:00Z");

  it("uses the registered provider each receipt names, and the earliest proven time", async () => {
    const seen: (Date | null)[] = [];
    const trust: TrustPolicy = {
      id: "record",
      evaluate: (_signer, context) => {
        seen.push(context.attestedAt);
        return Promise.resolve({ verdict: "trusted" });
      },
    };
    // Neither first nor last: the earliest must be found, not taken by position.
    const report = await verifyPackage(await withReceipts(["late", "early", "middle"]), {
      suites: [ed25519Suite()],
      anchors: [
        provider("decoy", { verdict: "invalid", reason: "wrong provider" }),
        provider("late", { verdict: "confirmed", attestedAt: LATE, confirmations: 7, source: "late chain" }),
        provider("early", { verdict: "confirmed", attestedAt: EARLY, confirmations: 9, source: "early chain" }),
        provider("middle", { verdict: "confirmed", attestedAt: MIDDLE }),
      ],
      chain,
      trust,
    });
    expect(report.axes).toMatchObject({ time: "confirmed", trust: "trusted", completeness: "full" });
    expect(report.overall).toBe("valid");
    expect(report.attestedAt).toBe(EARLY.toISOString());
    expect(seen).toEqual([EARLY]);
    const network = report.anchors[0]?.network;
    expect(report.anchors).toEqual([
      { entry: "anchors/seal-1.json", provider: "late", network, verdict: "confirmed", attestedAt: LATE.toISOString(), confirmations: 7, source: "late chain" },
      { entry: "anchors/seal-1.json", provider: "early", network, verdict: "confirmed", attestedAt: EARLY.toISOString(), confirmations: 9, source: "early chain" },
      { entry: "anchors/seal-1.json", provider: "middle", network, verdict: "confirmed", attestedAt: MIDDLE.toISOString() },
    ]);
    expect(report.issues).toEqual([]);
  });

  it("reports each receipt that is not confirmed, with the provider's reason or a default one", async () => {
    const report = await verifyPackage(await withReceipts(["quiet", "talkative", "missing"]), {
      suites: [ed25519Suite()],
      anchors: [provider("quiet", { verdict: "pending" }), provider("talkative", { verdict: "pending", reason: "waiting for a block" })],
      chain,
    });
    expect(report.axes).toMatchObject({ time: "pending", completeness: "incomplete" });
    expect(report.anchors.map(({ provider: p, verdict, reason }) => ({ p, verdict, reason }))).toEqual([
      { p: "quiet", verdict: "pending", reason: undefined },
      { p: "talkative", verdict: "pending", reason: "waiting for a block" },
      { p: "missing", verdict: "unsupported", reason: "No registered anchor provider missing" },
    ]);
    expect("reason" in (report.anchors[0] ?? {})).toBe(false);
    expect(report.issues).toEqual([
      { axis: "time", code: "pending", message: "Anchor is pending", subject: "anchors/seal-1.json" },
      { axis: "time", code: "pending", message: "waiting for a block", subject: "anchors/seal-1.json" },
      { axis: "time", code: "unsupported", message: "No registered anchor provider missing", subject: "anchors/seal-1.json" },
    ]);
  });
});

describe("trust", () => {
  it("asks the policy about every valid signer and reports each verdict and reason", async () => {
    const asked: string[] = [];
    const verdicts: TrustResult[] = [{ verdict: "trusted", reason: "pinned" }, { verdict: "unknown" }];
    const trust: TrustPolicy = {
      id: "test policy",
      evaluate: (signer) => {
        asked.push(signer);
        return Promise.resolve(verdicts[asked.length - 1] ?? { verdict: "untrusted" });
      },
    };
    const report = await verifyPackage(golden("valid-two-signers-pending-anchor.dseal"), { suites: [ed25519Suite()], trust });
    expect(asked).toEqual(report.signatures.map((s) => s.signer));
    expect(asked).toHaveLength(2);
    expect(report.signatures.map(({ trust: t, trustReason }) => ({ t, trustReason }))).toEqual([
      { t: "trusted", trustReason: "pinned" },
      { t: "unknown", trustReason: undefined },
    ]);
    expect("trustReason" in (report.signatures[1] ?? {})).toBe(false);
    expect(report.axes.trust).toBe("unknown");
    expect(report.issues.filter((i) => i.axis === "trust")).toEqual([
      { axis: "trust", code: "unknown", message: "Signer is unknown under policy test policy", subject: report.signatures[1]?.entry },
    ]);
  });
});

describe("reading", () => {
  it("passes on an error of the source instead of turning it into a verdict", async () => {
    const bytes = golden("valid-basic.dseal");
    const failing = (after: number): ByteSource => {
      let reads = 0;
      const inner = bytesSource(bytes);
      return {
        size: inner.size,
        read: (offset, length) => (++reads > after ? Promise.reject(new Error("disk gone")) : inner.read(offset, length)),
      };
    };
    await expect(verifyPackage(failing(0), { suites: [ed25519Suite()] })).rejects.toThrow("disk gone");
    // The same while the documents are hashed, once the container is open.
    const opening = { reads: 0 };
    const inner = bytesSource(bytes);
    await openContainer({ size: inner.size, read: (offset, length) => (opening.reads++, inner.read(offset, length)) });
    await expect(verifyPackage(failing(opening.reads), { suites: [ed25519Suite()] })).rejects.toThrow("disk gone");
  });
});
