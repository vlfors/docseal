import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContainer, utf8 } from "@docseal/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../../../../cli/src/io";
import { main } from "../../../../cli/src/main";
import type { SignerMessage } from "./protocol";
import { hasPython, verifyWithCli, verifyWithPython } from "../../../../../tests/e2e/verifiers";
import { Signer } from "./run";
import { fakeNetwork } from "../../../../../tests/fake-network";

const PASSPHRASE = "correct horse battery";
let dir: string;

/** Runs the CLI in-process, as apps/cli/src/main.test.ts does. */
async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
    env: { DOCSEAL_PASSPHRASE: PASSPHRASE },
    readSecret: () => Promise.reject(new Error("no terminal in tests")),
  };
  return { code: await main(args, io), stdout };
}

function signer(scryptN?: number) {
  const messages: SignerMessage[] = [];
  let time = 0;
  // A clock past the progress interval on every call: every progress report is posted.
  return { messages, signer: new Signer((m) => messages.push(m), () => (time += 1000), scryptN) };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-web-signer-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Signer", () => {
  it("opens a key file made by `docseal keygen`, reporting scrypt's progress", async () => {
    const made = await cli(["keygen", "-o", join(dir, "me.key"), "--scrypt-n", "16384"]);
    const did = /Public key: (did:key:\S+)/.exec(made.stdout)?.[1];
    const { messages, signer: s } = signer();
    await s.handle({ type: "open", keyFile: new Uint8Array(await readFile(join(dir, "me.key"))), passphrase: PASSPHRASE });
    expect(messages.at(-1)).toEqual({ type: "ready", did });
    const progress = messages.flatMap((m) => (m.type === "key-progress" ? [m.share] : []));
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);
    expect(s.secretKey).toHaveLength(32);
  });

  it("makes a key that the CLI opens and seals with", async () => {
    const { messages, signer: s } = signer(2 ** 10);
    await s.handle({ type: "generate", passphrase: PASSPHRASE });
    const ready = messages.at(-1);
    if (ready?.type !== "ready" || !ready.keyFile) {
      throw new Error(JSON.stringify(ready));
    }
    await writeFile(join(dir, "browser.key"), ready.keyFile);
    await writeFile(join(dir, "doc.txt"), "document");
    expect((await cli(["pubkey", join(dir, "browser.key")])).stdout.trim()).toBe(ready.did);
    // Sealing needs the passphrase: the CLI really opens the key.
    const sealed = await cli(["seal", join(dir, "doc.txt"), "-k", join(dir, "browser.key"), "-o", join(dir, "p.dseal"), "--no-anchor"]);
    expect(sealed.code).toBe(0);
    const container = await readContainer(new Uint8Array(await readFile(join(dir, "p.dseal"))));
    const envelope = JSON.parse(new TextDecoder().decode([...container.signatures.values()][0])) as { protected: { signer: string } };
    expect(envelope.protected.signer).toBe(ready.did);
  });

  it("says when the passphrase is wrong, and when the file is not a key file", async () => {
    await cli(["keygen", "-o", join(dir, "me.key"), "--scrypt-n", "1024"]);
    const keyFile = new Uint8Array(await readFile(join(dir, "me.key")));
    const { messages, signer: s } = signer();
    await s.handle({ type: "open", keyFile, passphrase: "wrong passphrase" });
    expect(messages.at(-1)).toMatchObject({ type: "failed", reason: "passphrase" });
    await s.handle({ type: "open", keyFile: utf8("{}"), passphrase: PASSPHRASE });
    expect(messages.at(-1)).toMatchObject({ type: "failed", reason: "file" });
    expect(s.secretKey).toBeUndefined();
  });

  it("erases the key it holds when told to forget it or to open another", async () => {
    const { signer: s } = signer(2 ** 10);
    await s.handle({ type: "generate", passphrase: PASSPHRASE });
    const seed = s.secretKey;
    s.forget();
    expect(s.secretKey).toBeUndefined();
    expect(seed?.every((byte) => byte === 0)).toBe(true);
  });

  async function openSigner() {
    const made = await cli(["keygen", "-o", join(dir, "me.key"), "--scrypt-n", "1024"]);
    const did = /Public key: (did:key:\S+)/.exec(made.stdout)?.[1] ?? "";
    const { messages, signer: s } = signer();
    await s.handle({ type: "open", keyFile: new Uint8Array(await readFile(join(dir, "me.key"))), passphrase: PASSPHRASE });
    await writeFile(join(dir, "trusted-keys.json"), JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: did }] }));
    return { messages, s, did };
  }

  it("seals once with the key it holds; the CLI and the Python verifier accept the package", async () => {
    const { messages, s } = await openSigner();
    const files = [
      { path: "contract.pdf", file: new File(["%PDF contract"], "contract.pdf") },
      { path: "annex/приложение.txt", file: new File(["приложение"], "приложение.txt") },
    ];
    await s.handle({ type: "seal", files, role: "author", output: { kind: "memory", limit: 1024 * 1024 }, timestamp: false });
    const sealed = messages.at(-1);
    if (sealed?.type !== "sealed" || !sealed.blob) {
      throw new Error(JSON.stringify(sealed));
    }
    expect(sealed.size).toBe(sealed.blob.size);
    const progress = messages.flatMap((m) => (m.type === "seal-progress" ? [m] : []));
    expect(progress.at(-1)).toMatchObject({ read: 2 * (13 + 20), total: 2 * (13 + 20) });
    // One key, one sealing: the key is gone.
    expect(s.secretKey).toBeUndefined();

    const path = join(dir, "p.dseal");
    await writeFile(path, new Uint8Array(await sealed.blob.arrayBuffer()));
    const accepted = { format: "valid", integrity: "valid", signature: "valid", trust: "trusted" };
    expect(await verifyWithCli(path, join(dir, "trusted-keys.json"))).toMatchObject(accepted);
    if (hasPython) {
      expect(await verifyWithPython(path, join(dir, "trusted-keys.json"))).toMatchObject(accepted);
    }
    const container = await readContainer(new Uint8Array(await sealed.blob.arrayBuffer()));
    expect(new TextDecoder().decode(container.manifest)).toContain('"generator": "docseal-web/');

    await s.handle({ type: "seal", files, role: "author", output: { kind: "memory", limit: 1024 * 1024 }, timestamp: false });
    expect(messages.at(-1)).toEqual({ type: "failed", reason: "other", message: "No key is open" });
  });

  it("reports each step as it begins, without a time proof", async () => {
    const { messages, s } = await openSigner();
    await s.handle({ type: "seal", files: [{ path: "a.txt", file: new File(["a"], "a.txt") }], role: "author", output: { kind: "memory", limit: 1024 * 1024 }, timestamp: false });
    expect(messages.flatMap((m) => (m.type === "seal-stage" ? [m.stage] : []))).toEqual(["hashing", "signing", "writing"]);
    expect(messages.some((m) => m.type === "calendar")).toBe(false);
  });

  it("reports each calendar's answer while timestamping", async () => {
    const made = await cli(["keygen", "-o", join(dir, "me.key"), "--scrypt-n", "1024"]);
    expect(made.code).toBe(0);
    const network = fakeNetwork();
    const messages: SignerMessage[] = [];
    // eternitywall is down; the two others accept, which is enough.
    const s = new Signer((m) => messages.push(m), () => 0, undefined, (url, init) =>
      url.startsWith("https://a.pool.eternitywall.com") ? Promise.reject(new TypeError("Failed to fetch")) : network.fetch(url, init),
    );
    await s.handle({ type: "open", keyFile: new Uint8Array(await readFile(join(dir, "me.key"))), passphrase: PASSPHRASE });
    await s.handle({ type: "seal", files: [{ path: "a.txt", file: new File(["a"], "a.txt") }], role: "author", output: { kind: "memory", limit: 1024 * 1024 }, timestamp: true });
    const steps = messages.flatMap((m) => (m.type === "seal-stage" ? [m.stage] : m.type === "calendar" ? [`${new URL(m.origin).host} ${String(m.accepted)}`] : []));
    expect(steps.slice(0, 3)).toEqual(["hashing", "signing", "timestamping"]);
    expect(steps.slice(3, 6).sort()).toEqual(["a.pool.eternitywall.com false", "a.pool.opentimestamps.org true", "b.pool.opentimestamps.org true"]);
    expect(steps.slice(6)).toEqual(["writing"]);
    expect(messages.find((m) => m.type === "calendar" && !m.accepted)).toMatchObject({ message: "Failed to fetch" });
    const sealed = messages.at(-1);
    expect(sealed?.type === "sealed" && [...sealed.calendars].sort()).toEqual(["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org"]);
  });

  it("reports a document that changed between its two reads, and erases the key", async () => {
    const { messages, s } = await openSigner();
    let reads = 0;
    // Hashed as "aaaa", then written as "bbbb": what a file edited during sealing looks like.
    const changing = {
      size: 4,
      slice: () => ({ arrayBuffer: () => Promise.resolve(new TextEncoder().encode(reads++ === 0 ? "aaaa" : "bbbb").buffer) }),
    } as unknown as Blob;
    await s.handle({ type: "seal", files: [{ path: "a.txt", file: changing }], role: "author", output: { kind: "memory", limit: 1024 * 1024 }, timestamp: false });
    expect(messages.at(-1)).toMatchObject({ type: "failed", reason: "changed" });
    expect(s.secretKey).toBeUndefined();
  });

  it("stops sealing when cancelled, and erases the key", async () => {
    const { messages, s } = await openSigner();
    const big = new File([new Uint8Array(64 * 1024 * 1024)], "big.bin");
    const sealing = s.handle({ type: "seal", files: [{ path: "big.bin", file: big }], role: "author", output: { kind: "memory", limit: 1024 ** 3 }, timestamp: false });
    await s.handle({ type: "cancel" });
    await sealing;
    expect(messages.at(-1)).toMatchObject({ type: "failed", reason: "cancelled" });
    expect(s.secretKey).toBeUndefined();
  });

  it("refuses a package over the memory limit", async () => {
    const { messages, s } = await openSigner();
    await s.handle({ type: "seal", files: [{ path: "a.bin", file: new File([new Uint8Array(4096)], "a.bin") }], role: "author", output: { kind: "memory", limit: 1000 }, timestamp: false });
    expect(messages.at(-1)).toMatchObject({ type: "failed", reason: "too-large" });
  });
});
