import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContainer, utf8 } from "@docseal/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "../../../../cli/src/io";
import { main } from "../../../../cli/src/main";
import type { SignerMessage } from "./protocol";
import { Signer } from "./run";

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
});
