import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeTimestamp, type Fetch } from "@docseal/anchor-ots";
import { fromHex, hash, readContainer, toHex, utf8, writeContainer, type VerificationReport } from "@docseal/core";
import { beforeEach, describe, expect, it } from "vitest";
import { ExitCode, type Io } from "./io.js";
import { main } from "./main.js";

const PASSPHRASE = "correct horse battery";
const CALENDAR_URI = "https://alice.btc.calendar.opentimestamps.org";
const HEIGHT = 900_000;
const BLOCK_TIME = 1_750_000_000;

/**
 * One fake network for calendars and Esplora: submissions get a pending proof; after
 * `confirm()`, the calendar returns a Bitcoin attestation and Esplora serves a block whose
 * merkle root is that commitment.
 */
function fakeNetwork() {
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
    if (url === "https://pool.test/digest" && init?.body instanceof Uint8Array) {
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

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

let dir: string;
let network: ReturnType<typeof fakeNetwork>;

async function run(args: string[], env: Record<string, string> = { DOCSEAL_PASSPHRASE: PASSPHRASE }): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env,
    fetch: network.fetch,
    readSecret: () => Promise.reject(new Error("no terminal in tests")),
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}

const path = (name: string) => join(dir, name);

async function setupDocuments(): Promise<void> {
  await mkdir(path("docs/annex"), { recursive: true });
  await writeFile(path("docs/contract.pdf"), "%PDF contract body");
  await writeFile(path("docs/annex/приложение.txt"), "приложение 1");
  await writeFile(path("cover.txt"), "cover letter");
}

async function keygen(): Promise<string> {
  const result = await run(["keygen", "-o", path("me.key"), "--scrypt-n", "1024"]);
  expect(result.code).toBe(ExitCode.Valid);
  const did = /Public key: (did:key:\S+)/.exec(result.stdout)?.[1];
  if (!did) throw new Error(result.stdout);
  await writeFile(
    path("trusted-keys.json"),
    JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: did, label: "Me" }] }),
  );
  return did;
}

const sealArgs = () => ["seal", path("docs"), path("cover.txt"), "-k", path("me.key"), "-o", path("p.dseal"), "--calendar", "https://pool.test"];
const verifyArgs = (...extra: string[]) => ["verify", path("p.dseal"), "--trust", path("trusted-keys.json"), "--chain", "https://esplora.test", ...extra];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-cli-"));
  network = fakeNetwork();
  await setupDocuments();
});

describe("docseal CLI", () => {
  it("keygen → seal → verify (pending) → upgrade → verify (valid) → mutate (invalid)", async () => {
    const did = await keygen();
    expect((await stat(path("me.key"))).mode & 0o777).toBe(0o600);
    expect((await run(["pubkey", path("me.key")])).stdout.trim()).toBe(did);

    const sealed = await run(sealArgs());
    expect(sealed.stderr).toBe("");
    expect(sealed.code).toBe(ExitCode.Valid);
    expect(sealed.stdout).toContain("Sealed 3 files");
    expect(sealed.stdout).toContain(did);
    expect([...(await readContainer(new Uint8Array(await readFile(path("p.dseal"))))).files.keys()].sort()).toEqual([
      "annex/приложение.txt",
      "contract.pdf",
      "cover.txt",
    ]);

    const pending = await run(verifyArgs());
    expect(pending.code).toBe(ExitCode.Indeterminate);
    expect(pending.stdout).toMatch(/^INDETERMINATE/);
    expect(pending.stdout).toMatch(/time\s+pending/);
    expect(pending.stdout).toContain("docseal upgrade");

    const early = await run(["upgrade", path("p.dseal")]);
    expect(early.stdout).toContain("No change");

    network.confirm();
    const upgraded = await run(["upgrade", path("p.dseal")]);
    expect(upgraded.code).toBe(ExitCode.Valid);
    expect(upgraded.stdout).toContain(`confirmed at block ${String(HEIGHT)}`);

    const valid = await run(verifyArgs());
    expect(valid.code).toBe(ExitCode.Valid);
    expect(valid.stdout).toMatch(/^VALID/);
    expect(valid.stdout).toContain("3 of 3 files match");
    expect(valid.stdout).toContain("10 confirmations via esplora https://esplora.test");

    const json = await run(verifyArgs("--json"));
    const report = JSON.parse(json.stdout) as VerificationReport;
    expect(report.overall).toBe("valid");
    expect(report.attestedAt).toBe(new Date(BLOCK_TIME * 1000).toISOString());

    const contents = await readContainer(new Uint8Array(await readFile(path("p.dseal"))));
    contents.files.set("contract.pdf", utf8("%PDF forged body!!"));
    await writeFile(path("p.dseal"), await writeContainer(contents));
    const tampered = await run(verifyArgs());
    expect(tampered.code).toBe(ExitCode.Invalid);
    expect(tampered.stdout).toMatch(/^INVALID/);
    expect(tampered.stdout).toMatch(/modified\s+contract\.pdf/);
  });

  it("reports an untrusted or unevaluated signer as indeterminate", async () => {
    await keygen();
    await run([...sealArgs(), "--no-anchor"].filter((a) => a !== "--calendar" && a !== "https://pool.test"));
    const noTrust = await run(["verify", path("p.dseal"), "--offline"]);
    expect(noTrust.code).toBe(ExitCode.Indeterminate);
    expect(noTrust.stdout).toContain("pass --trust");
    expect(noTrust.stdout).toContain("--no-anchor");

    await writeFile(path("other.json"), JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: "did:key:zOther" }] }));
    const untrusted = await run(["verify", path("p.dseal"), "--trust", path("other.json"), "--offline"]);
    expect(untrusted.code).toBe(ExitCode.Indeterminate);
    expect(untrusted.stdout).toMatch(/trust\s+untrusted/);
  });

  it("does not contact the network with --offline or --no-anchor", async () => {
    await keygen();
    await run(["seal", path("cover.txt"), "-k", path("me.key"), "-o", path("p.dseal"), "--no-anchor"]);
    await run(["verify", path("p.dseal"), "--offline"]);
    expect(network.requests).toEqual([]);
  });

  it("fails cleanly on a wrong passphrase, existing output, links, and bad input", async () => {
    await keygen();
    const wrong = await run(sealArgs(), { DOCSEAL_PASSPHRASE: "nope" });
    expect(wrong).toMatchObject({ code: ExitCode.Error, stderr: "docseal: Wrong passphrase or corrupted key file\n" });

    expect((await run(sealArgs())).code).toBe(ExitCode.Valid);
    expect((await run(sealArgs())).stderr).toContain("already exists; use --force");
    expect((await run([...sealArgs(), "--force"])).code).toBe(ExitCode.Valid);

    await symlink(path("cover.txt"), path("docs/link.txt"));
    expect((await run([...sealArgs(), "--force"])).stderr).toContain("symbolic link");

    expect((await run(["verify", path("missing.dseal")])).code).toBe(ExitCode.Error);
    await writeFile(path("garbage.dseal"), "not a zip");
    expect((await run(["verify", path("garbage.dseal"), "--offline"])).code).toBe(ExitCode.Invalid);
    expect((await run(["keygen", "-o", path("me.key"), "--scrypt-n", "1024"])).code).toBe(ExitCode.Error);
  });

  it("asks for a passphrase only on a terminal", async () => {
    const result = await run(["keygen", "-o", path("k.key")], {});
    expect(result.code).toBe(ExitCode.Error);
    expect(result.stderr).toContain("set DOCSEAL_PASSPHRASE");
  });

  it("prints package text safely: control sequences cannot redraw the verdict", async () => {
    await keygen();
    await run(["seal", path("cover.txt"), "-k", path("me.key"), "-o", path("p.dseal"), "--no-anchor", "--role", "author"]);
    const contents = await readContainer(new Uint8Array(await readFile(path("p.dseal"))));
    const envelope = JSON.parse(new TextDecoder().decode(contents.signatures.get("signatures/0001.json"))) as {
      protected: Record<string, unknown>;
    };
    envelope.protected.role = "\u001b[2J\u001b[HVALID: every check passed\u202e";
    contents.signatures.set("signatures/0001.json", utf8(JSON.stringify(envelope)));
    contents.files.set("cover.txt", utf8("modified"));
    await writeFile(path("p.dseal"), await writeContainer(contents));

    const result = await run(["verify", path("p.dseal"), "--offline"]);
    expect(result.code).toBe(ExitCode.Invalid);
    expect(result.stdout).toMatch(/^INVALID/);
    expect(result.stdout.includes("\u001b") || result.stdout.includes("\u202e")).toBe(false);
    expect(result.stdout).toContain("\\u001b[2J");
  });

  it("handles help, version, and usage errors", async () => {
    expect((await run(["--version"])).stdout).toContain("format v1");
    expect((await run(["--help"])).code).toBe(ExitCode.Valid);
    expect((await run(["frobnicate"])).code).toBe(ExitCode.Error);
    expect((await run(["seal", path("cover.txt")])).code).toBe(ExitCode.Error);
    expect((await run(["verify", "x", "--min-confirmations", "-1"])).code).toBe(ExitCode.Error);
  });
});
