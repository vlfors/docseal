/**
 * The built docseal-mcp, started over stdio by the SDK's client as an MCP client would start it,
 * in both protocol eras: every verdict, inspect, upgrade, seal accepted and declined, and paths
 * outside the roots. The network is fake (fake-network.mjs); everything else is the release build.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../..");
const BIN = join(REPO, "apps/mcp/dist/index.js");
const CLI = join(REPO, "apps/cli/dist/index.js");
const PRELOAD = join(import.meta.dirname, "fake-network.mjs");
const GOLDEN = join(REPO, "spec/vectors/packages");
const PASSPHRASE = "correct horse battery";

let dir: string;
let network: string;
let root: string;
let did: string;
const clients: Client[] = [];

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "docseal-mcp-e2e-")));
  network = join(dir, "network");
  root = join(dir, "root");
  await mkdir(network);
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "contract.pdf"), "%PDF the contract");
  await writeFile(join(root, "docs", "annex.txt"), "annex");
  for (const name of ["valid-basic.dseal", "tampered-content.dseal", "valid-pending-anchor.dseal"]) {
    await copyFile(join(GOLDEN, name), join(root, name));
  }
  const keygen = spawnSync(process.execPath, [CLI, "keygen", "-o", join(dir, "me.key"), "--scrypt-n", "1024"], {
    env: { PATH: process.env.PATH, DOCSEAL_PASSPHRASE: PASSPHRASE },
    encoding: "utf8",
  });
  did = /Public key: (did:key:\S+)/.exec(keygen.stdout)?.[1] ?? "";
  expect(did).toMatch(/^did:key:z6Mk/);
  await writeFile(join(dir, "trusted-keys.json"), JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: did, label: "Me" }] }));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const env = { PATH: process.env.PATH ?? "", DOCSEAL_TEST_NETWORK: "", DOCSEAL_PASSPHRASE: PASSPHRASE };
const serverArgs = () => [
  "--root",
  root,
  "--trust",
  join(dir, "trusted-keys.json"),
  "--chain",
  "https://esplora.test",
  "--allow-seal",
  "--key",
  join(dir, "me.key"),
];

type Era = "modern" | "legacy";

async function start(era: Era, answer: "accept" | "decline" = "accept"): Promise<{ client: Client; stderr: () => string; asked: () => number }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", PRELOAD, BIN, ...serverArgs()],
    env: { ...env, DOCSEAL_TEST_NETWORK: network },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  let asked = 0;
  const client = new Client(
    { name: "e2e", version: "0" },
    { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: era === "modern" ? "auto" : "legacy" } },
  );
  client.setRequestHandler("elicitation/create", () => {
    asked++;
    return answer === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
  });
  await client.connect(transport);
  clients.push(client);
  expect(client.getNegotiatedProtocolVersion()).toBe(era === "modern" ? "2026-07-28" : "2025-11-25");
  return { client, stderr: () => stderr, asked: () => asked };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T & { isError?: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return { ...(result.structuredContent as T), isError: result.isError === true, text };
}

interface Verified {
  verdict: string;
  summary: string;
  notConfirmed: string[];
  report: { axes: Record<string, string> };
}

describe.each<Era>(["modern", "legacy"])("docseal-mcp over stdio (%s)", (era) => {
  it("starts with the key checked, and lists its tools and prompt", async () => {
    const { client, stderr } = await start(era);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["verify", "inspect", "upgrade", "list_trusted_keys", "seal"]);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(["check-package"]);
    expect(stderr()).toContain(`sealing on, as ${did}`);
    expect(stderr()).not.toContain(PASSPHRASE);
  });

  it("gives each verdict in DocSeal's own words", async () => {
    const { client } = await start(era);
    const indeterminate = await call<Verified>(client, "verify", { path: "valid-basic.dseal" });
    expect(indeterminate.verdict).toBe("indeterminate");
    expect(indeterminate.summary).toMatch(/^INDETERMINATE\. Not confirmed: who owns the signing key; when the files existed\./);
    const invalid = await call<Verified>(client, "verify", { path: "tampered-content.dseal" });
    expect(invalid.verdict).toBe("invalid");
    expect(invalid.summary).toBe("INVALID: do not rely on this package. 1 of 3 files are modified, missing, or extra.");
    expect(invalid.text.startsWith(`${invalid.summary}\n\n{`)).toBe(true);
  });

  it("inspects without a verdict", async () => {
    const { client } = await start(era);
    const out = await call<{ verified: boolean; timeProof: string; files: unknown[] }>(client, "inspect", { path: "valid-pending-anchor.dseal" });
    expect(out).toMatchObject({ verified: false, timeProof: "pending" });
    expect(out.files).toHaveLength(3);
  });

  it("refuses paths outside the roots", async () => {
    const { client } = await start(era);
    for (const path of ["../trusted-keys.json", join(dir, "me.key"), join(GOLDEN, "valid-basic.dseal")]) {
      const out = await call(client, "verify", { path });
      expect(out.isError, path).toBe(true);
      expect(out.text, path).toContain("outside the directories this server may read");
    }
  });

  it("writes nothing when the person declines to seal", async () => {
    const { client, asked } = await start(era, "decline");
    const out = await call<{ sealed: boolean }>(client, "seal", { paths: ["docs"], output: `declined-${era}.dseal` });
    expect(out.sealed).toBe(false);
    expect(asked()).toBe(1);
    expect(await readdir(root)).not.toContain(`declined-${era}.dseal`);
  });

  it("seals with confirmation, upgrades, and verifies the result as valid", async () => {
    await rm(join(network, "confirmed"), { force: true });
    const { client, asked } = await start(era);
    const sealed = await call<{ sealed: boolean; signer: string; time: string }>(client, "seal", {
      paths: ["docs"],
      output: `sealed-${era}.dseal`,
      title: "End to end",
    });
    expect(sealed).toMatchObject({ sealed: true, signer: did, time: "pending" });
    expect(asked()).toBe(1);

    const pending = await call<Verified>(client, "verify", { path: `sealed-${era}.dseal` });
    expect(pending.notConfirmed).toEqual(["when the files existed"]);
    expect(await call(client, "upgrade", { path: `sealed-${era}.dseal` })).toMatchObject({ changed: false, stage: "submitted" });

    await writeFile(join(network, "confirmed"), "");
    const upgraded = await call<{ changed: boolean; stage: string; written: string }>(client, "upgrade", { path: `sealed-${era}.dseal` });
    expect(upgraded).toMatchObject({ changed: true, stage: "confirmed", written: join(root, `sealed-${era}.upgraded.dseal`) });

    const valid = await call<Verified>(client, "verify", { path: `sealed-${era}.upgraded.dseal` });
    expect(valid.verdict).toBe("valid");
    expect(valid.summary).toMatch(/^VALID: the files are unchanged, they were signed by a trusted key, and they existed no later than /);

    // The CLI agrees.
    const cli = spawnSync(
      process.execPath,
      ["--import", PRELOAD, CLI, "verify", join(root, `sealed-${era}.upgraded.dseal`), "--trust", join(dir, "trusted-keys.json"), "--chain", "https://esplora.test"],
      { env: { ...env, DOCSEAL_TEST_NETWORK: network }, encoding: "utf8" },
    );
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const requests = await readFile(join(network, "requests.log"), "utf8");
    expect(requests).toContain("POST https://");
    expect(requests).not.toMatch(/the contract|annex/);
  });
});

describe("the stdio channel", () => {
  it("carries nothing but JSON-RPC messages on stdout", async () => {
    const child = spawn(process.execPath, ["--import", PRELOAD, BIN, ...serverArgs()], {
      env: { ...env, DOCSEAL_TEST_NETWORK: network },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "verify", arguments: { path: "valid-basic.dseal" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "verify", arguments: { path: "/etc/passwd" } } },
    ];
    // Requests still running when stdin closes are dropped, as the stdio binding asks: close it
    // once every answer is in.
    child.stdout.on("data", () => {
      if (stdout.trim().split("\n").length === 3) child.stdin.end();
    });
    child.stdin.write(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    const messages = stdout.trim().split("\n").map((line) => JSON.parse(line) as { jsonrpc: string; id: number });
    // Answers may come in any order: a refused path is quicker than a verification.
    expect(messages.map((message) => [message.jsonrpc, message.id]).sort()).toEqual([
      ["2.0", 1],
      ["2.0", 2],
      ["2.0", 3],
    ]);
  });
});
