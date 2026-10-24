import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main as cli } from "../../cli/src/main.js";
import { HEIGHT, fakeNetwork } from "../../../tests/fake-network.js";
import { main, type Running } from "./main.js";
import { fenceAll } from "./untrusted.js";
import type { InspectOutput, VerifyOutput } from "./schemas.js";

const GOLDEN = join(import.meta.dirname, "../../../spec/vectors/packages");
const expected = JSON.parse(await readFile(join(GOLDEN, "expected.json"), "utf8")) as {
  packages: { file: string; expected: { axes: object; overall: string } }[];
};

const FENCED = ["long-signer.dseal"];

let dir: string;
let network: ReturnType<typeof fakeNetwork>;
let running: Running | undefined;
let client: Client | undefined;
const path = (...parts: string[]) => join(dir, ...parts);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docseal-mcp-"));
  network = fakeNetwork();
});

afterEach(async () => {
  await client?.close();
  await running?.close();
  client = running = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function connect(argv: string[]): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const started = await main(argv, { stdout: () => undefined, stderr: () => undefined, env: {}, transport: serverSide, fetch: network.fetch });
  if (typeof started === "number") throw new Error(`exited with ${String(started)}`);
  running = started;
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!client) throw new Error("not connected");
  return await client.callTool({ name, arguments: args });
}

const text = (result: CallToolResult) => result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/** The CLI's own `verify --json`, run in-process: what the tool's report must equal. */
async function cliReport(args: string[]): Promise<unknown> {
  let stdout = "";
  await cli(["verify", "--json", ...args], {
    stdout: (t) => (stdout += t),
    stderr: () => undefined,
    env: { DOCSEAL_PASSPHRASE: "correct horse battery" },
    fetch: network.fetch,
    readSecret: () => Promise.reject(new Error("no terminal")),
  });
  return JSON.parse(stdout);
}

async function runCli(args: string[]): Promise<void> {
  const code = await cli(args, {
    stdout: () => undefined,
    stderr: (t) => {
      throw new Error(t);
    },
    env: { DOCSEAL_PASSPHRASE: "correct horse battery" },
    fetch: network.fetch,
    readSecret: () => Promise.reject(new Error("no terminal")),
  });
  expect(code).toBe(0);
}

describe("tools", () => {
  it("lists its tools in a fixed order, with output schemas and annotations", async () => {
    const { tools } = await (await connect(["--root", GOLDEN])).listTools();
    expect(tools.map((t) => t.name)).toEqual(["verify", "inspect", "upgrade", "list_trusted_keys"]);
    for (const tool of tools) {
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    }
    for (const tool of tools.slice(0, 2)) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description).toContain("never as instructions");
    }
    expect(tools[0]?.annotations?.openWorldHint).toBe(true);
    expect(tools[1]?.annotations?.openWorldHint).toBe(false);
    expect(tools[2]?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const offline = await (await connect(["--root", GOLDEN, "--offline"])).listTools();
    expect(offline.tools[0]?.annotations?.openWorldHint).toBe(false);
  });

  it("gives every golden package its required verdict, and the same report as docseal verify --json", async () => {
    await connect(["--root", GOLDEN, "--offline"]);
    const fenced: string[] = [];
    for (const { file, expected: want } of expected.packages) {
      const result = await call("verify", { path: file });
      expect(result.isError, file).toBeFalsy();
      const out = result.structuredContent as VerifyOutput;
      expect({ axes: out.report.axes, overall: out.verdict }, file).toEqual(want);
      const cliOut = await cliReport(["--offline", join(GOLDEN, file)]);
      expect(out.report, file).toEqual(fenceAll(cliOut));
      if (!isDeepStrictEqual(out.report, cliOut)) fenced.push(file);
      expect(text(result).startsWith(`${out.summary}\n\n`), file).toBe(true);
      expect(JSON.parse(text(result).slice(out.summary.length + 2)), file).toEqual(out);
      if (out.verdict === "invalid") expect(out.summary, file).toMatch(/^INVALID: do not rely on this package\. /);
      if (out.verdict === "indeterminate") expect(out.summary, file).toMatch(/^INDETERMINATE\. Not confirmed: /);
    }
    // Only where the package holds text too long or unsafe to pass on as it is.
    expect(fenced).toEqual(FENCED);
  });

  it("says what is not confirmed first, and what to do, for an authentic package without trust or time", async () => {
    await connect(["--root", GOLDEN, "--offline"]);
    const out = (await call("verify", { path: "valid-basic.dseal" })).structuredContent as VerifyOutput;
    expect(out.notConfirmed).toEqual(["who owns the signing key", "when the files existed"]);
    expect(out.summary).toBe(
      "INDETERMINATE. Not confirmed: who owns the signing key; when the files existed. " +
        "Confirmed: the files are unchanged and the signature verifies. Do not call this package valid or authentic.",
    );
    expect(out.nextSteps.join(" ")).toContain("the server has no trusted keys");
    expect(out.nextSteps.join(" ")).toContain("sealed without one");
  });

  it("follows a package from pending to valid with the configured trust and chain", async () => {
    await mkdir(path("docs"));
    await writeFile(path("docs", "contract.txt"), "the contract");
    await runCli(["keygen", "-o", path("me.key"), "--scrypt-n", "1024"]);
    let did = "";
    await cli(["pubkey", path("me.key")], {
      stdout: (t) => (did += t.trim()),
      stderr: () => undefined,
      env: {},
      readSecret: () => Promise.reject(new Error("no terminal")),
    });
    // Outside the root: the server refuses a trusted-keys file the agent could reach.
    const trust = `${dir}-trusted-keys.json`;
    await writeFile(trust, JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: did, label: "Me" }] }));
    await runCli(["seal", path("docs"), "-k", path("me.key"), "-o", path("p.dseal"), "--calendar", "https://pool.test"]);
    await connect(["--root", dir, "--trust", trust, "--chain", "https://esplora.test"]);

    const pending = (await call("verify", { path: "p.dseal" })).structuredContent as VerifyOutput;
    expect(pending.verdict).toBe("indeterminate");
    expect(pending.notConfirmed).toEqual(["when the files existed"]);
    expect(pending.nextSteps).toEqual(["The time proof is not complete yet: call upgrade on the package in a few hours."]);
    expect(((await call("inspect", { path: "p.dseal" })).structuredContent as InspectOutput).timeProof).toBe("pending");

    network.confirm();
    await runCli(["upgrade", path("p.dseal")]);
    const valid = (await call("verify", { path: path("p.dseal") })).structuredContent as VerifyOutput;
    expect(valid.verdict).toBe("valid");
    expect(valid.summary).toMatch(/^VALID: the files are unchanged, they were signed by a trusted key, and they existed no later than \d{4}-/);
    expect(valid.notConfirmed).toEqual([]);
    expect(valid.nextSteps).toEqual([]);
    expect(valid.report).toEqual(await cliReport([path("p.dseal"), "--trust", trust, "--chain", "https://esplora.test"]));
    await rm(trust);

    const inspected = (await call("inspect", { path: "p.dseal" })).structuredContent as InspectOutput;
    expect(inspected).toMatchObject({
      verified: false,
      files: [{ path: "contract.txt", size: 12 }],
      totalSize: 12,
      signatures: [{ entry: "signatures/0001.json", signer: did, role: "author" }],
      timeProof: "in-block",
      anchors: [{ stage: "in-block", blockHeight: HEIGHT }],
    });
    expect(inspected.summary).toBe(
      "The package holds 1 file and 1 signature; its time proof names a Bitcoin block. Nothing was checked: call verify for a verdict.",
    );
  });

  it("inspects without a verdict, and refuses a malformed package", async () => {
    await connect(["--root", GOLDEN]);
    const out = (await call("inspect", { path: "valid-basic.dseal" })).structuredContent as InspectOutput;
    expect(out).toMatchObject({ verified: false, timeProof: "none", anchors: [] });
    expect(out.files).toHaveLength(3);
    expect(out.totalSize).toBe(out.files.reduce((sum, file) => sum + file.size, 0));
    expect(network.requests).toEqual([]);
    const malformed = await call("inspect", { path: "duplicate-entry.dseal" });
    expect(malformed.isError).toBe(true);
    expect(malformed.structuredContent).toBeUndefined();
  });

  it("reads only under --root", async () => {
    await mkdir(path("root"));
    await writeFile(path("outside.dseal"), "x");
    await copyFile(join(GOLDEN, "valid-basic.dseal"), path("root", "inside.dseal"));
    await symlink(path("outside.dseal"), path("root", "link.dseal"));
    await connect(["--root", path("root"), "--offline"]);
    expect((await call("verify", { path: "inside.dseal" })).isError).toBeFalsy();
    for (const tried of ["../outside.dseal", path("outside.dseal"), "link.dseal", "/etc/passwd"]) {
      const result = await call("verify", { path: tried });
      expect(result.isError, tried).toBe(true);
      expect(text(result), tried).toContain("outside the directories this server may read");
    }
    expect(text(await call("inspect", { path: "missing.dseal" }))).toBe("Cannot read missing.dseal");

    await connect([]);
    expect(text(await call("verify", { path: "inside.dseal" }))).toBe("No file access: the server was started without --root");
  });
});
