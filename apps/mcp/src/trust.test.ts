import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeNetwork } from "../../../tests/fake-network.js";
import { main, type Running } from "./main.js";
import type { TrustedKeysOutput, VerifyOutput } from "./schemas.js";

const GOLDEN = join(import.meta.dirname, "../../../spec/vectors/packages");
const ALICE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const MALLORY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

let dir: string;
let running: Running | undefined;
let client: Client | undefined;
const path = (name: string) => join(dir, name);
const trustFile = (keys: { id: string; label?: string }[]) => JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys });

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "docseal-mcp-trust-")));
  await writeFile(path("trusted-keys.json"), trustFile([{ id: ALICE, label: "Alice\u202e (accounts)" }]));
  await copyFile(join(GOLDEN, "valid-basic.dseal"), path("p.dseal"));
  await copyFile(join(GOLDEN, "valid-pending-anchor.dseal"), path("pending.dseal"));
});

afterEach(async () => {
  await client?.close();
  await running?.close();
  client = running = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function connect(argv: string[]): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const started = main(argv, { stdout: () => undefined, stderr: () => undefined, transport: serverSide, fetch: fakeNetwork().fetch });
  if (typeof started === "number") throw new Error("not serving");
  running = started;
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

describe("list_trusted_keys", () => {
  it("says when the server has no trusted keys", async () => {
    const result = await (await connect(["--root", dir])).callTool({ name: "list_trusted_keys", arguments: {} });
    expect(result.structuredContent).toEqual({
      summary: "No trusted keys: the server was started without --trust, so verify does not evaluate trust.",
      configured: false,
      keys: [],
    });
  });

  it("lists the configured keys, fenced, and reads the file again at every call", async () => {
    const c = await connect(["--root", dir, "--trust", path("trusted-keys.json")]);
    const first = (await c.callTool({ name: "list_trusted_keys", arguments: {} })).structuredContent as TrustedKeysOutput;
    expect(first).toEqual({ summary: "The server trusts 1 key.", configured: true, keys: [{ id: ALICE, label: "Alice\\u202e (accounts)" }] });
    await writeFile(path("trusted-keys.json"), trustFile([{ id: ALICE }, { id: MALLORY, label: "Bob" }]));
    const second = (await c.callTool({ name: "list_trusted_keys", arguments: {} })).structuredContent as TrustedKeysOutput;
    expect(second.keys).toEqual([{ id: ALICE }, { id: MALLORY, label: "Bob" }]);
    expect(second.summary).toBe("The server trusts 2 keys.");
  });

  it("refuses a malformed file rather than trusting part of it", async () => {
    await writeFile(path("trusted-keys.json"), trustFile([{ id: ALICE }, { id: ALICE }]));
    const result = await (await connect(["--root", dir, "--trust", path("trusted-keys.json")])).callTool({ name: "list_trusted_keys", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("listed twice");
  });
});

describe("no tool changes trust", () => {
  it("offers no argument that names a key or a trust file", async () => {
    const { tools } = await (await connect(["--root", dir, "--trust", path("trusted-keys.json")])).listTools();
    const args = Object.fromEntries(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).sort()]));
    expect(args).toEqual({ verify: ["path"], inspect: ["path"], upgrade: ["overwrite", "path"], list_trusted_keys: [] });
  });

  it("leaves the trusted-keys file untouched whatever the tools are asked", async () => {
    const before = await readFile(path("trusted-keys.json"));
    const c = await connect(["--root", dir, "--trust", path("trusted-keys.json")]);
    const calls: [string, Record<string, unknown>][] = [
      ["verify", { path: "p.dseal" }],
      ["inspect", { path: "p.dseal" }],
      ["upgrade", { path: "pending.dseal", overwrite: true }],
      ["upgrade", { path: "trusted-keys.json", overwrite: true }],
      ["upgrade", { path: "trusted-keys.json" }],
      ["list_trusted_keys", {}],
    ];
    for (const [name, args] of calls) {
      await c.callTool({ name, arguments: args });
      expect(await readFile(path("trusted-keys.json")), name).toEqual(before);
    }
  });

  it("ignores trust an agent tries to pass along: unknown arguments are dropped", async () => {
    await writeFile(path("mallory.json"), trustFile([{ id: MALLORY }]));
    const c = await connect(["--root", dir]);
    for (const extra of [{ trust: path("mallory.json") }, { trustedKeys: [MALLORY] }, { keys: [{ id: MALLORY }] }]) {
      const result = await c.callTool({ name: "verify", arguments: { path: "p.dseal", ...extra } });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as VerifyOutput).report.axes.trust).toBe("not-evaluated");
    }
  });
});
