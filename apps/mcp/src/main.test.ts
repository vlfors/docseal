import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE } from "./config.js";
import { main, type Running } from "./main.js";
import { NAME, VERSION } from "./server.js";

async function run(argv: string[], transport?: InMemoryTransport, env: Record<string, string> = {}) {
  const out = { stdout: "", stderr: "" };
  const result = await main(argv, {
    env,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    ...(transport ? { transport } : {}),
  });
  return { ...out, result };
}

let running: Running | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await running?.close();
  client = running = undefined;
  vi.restoreAllMocks();
});

/** Starts the server on an in-memory pipe and connects a client to it. */
async function connect(argv: string[] = [], era: "modern" | "legacy" = "modern") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const started = await run(argv, serverSide);
  if (typeof started.result === "number") throw new Error(`exited with ${String(started.result)}`);
  running = started.result;
  client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode: era === "legacy" ? "legacy" : "auto" } });
  await client.connect(clientSide);
  expect(client.getNegotiatedProtocolVersion()).toBe(era === "legacy" ? "2025-11-25" : "2026-07-28");
  return { client, started };
}

describe("docseal-mcp", () => {
  it("prints help and the version without serving", async () => {
    expect(await run(["--help"])).toMatchObject({ result: 0, stdout: USAGE, stderr: "" });
    expect(await run(["-v"])).toMatchObject({ result: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it.each([
    [["--unknown"], "Unknown option"],
    [["stray"], "positional"],
    [["--allow-seal"], "--allow-seal and --key go together"],
    [["--key", "a.key"], "--allow-seal and --key go together"],
    [["--offline", "--chain", "https://example.org/api"], "contradict"],
    [["--root", "/nonexistent/docseal"], "--root /nonexistent/docseal is not a directory"],
    [["--root", import.meta.filename], "is not a directory"],
  ])("refuses %j before serving", async (argv, message) => {
    const { result, stdout, stderr } = await run(argv);
    expect(result).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(message);
    expect(stderr).toContain("Usage: docseal-mcp");
  });

  it.each(["modern", "legacy"] as const)("serves a %s client with its name, version, and tool list", async (era) => {
    const { client } = await connect([], era);
    expect(client.getServerVersion()).toMatchObject({ name: NAME, version: VERSION });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["verify", "inspect", "upgrade", "list_trusted_keys"]);
    const golden = join(import.meta.dirname, "../../../spec/vectors/packages");
    await client.close();
    await running?.close();
    const again = await connect(["--root", golden, "--offline"], era);
    const result = await again.client.callTool({ name: "verify", arguments: { path: "valid-basic.dseal" } });
    expect(result.structuredContent).toMatchObject({ verdict: "indeterminate" });
  });

  it("writes nothing to stdout while serving and says on stderr what it allows", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    const { client, started } = await connect(["--root", tmpdir()]);
    await client.listTools();
    expect(started.stdout).toBe("");
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(started.stderr).toBe(`${NAME} ${VERSION}: serving on stdio; files under ${tmpdir()}; sealing off\n`);
  });

  it("says when it has no file access", async () => {
    const { started } = await connect();
    expect(started.stderr).toContain("no file access (no --root); sealing off");
  });
});
