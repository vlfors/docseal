import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE } from "./config.js";
import { main, type Running } from "./main.js";
import { NAME, VERSION } from "./server.js";

function run(argv: string[], transport?: InMemoryTransport) {
  const out = { stdout: "", stderr: "" };
  const result = main(argv, {
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
  const started = run(argv, serverSide);
  if (typeof started.result === "number") throw new Error(`exited with ${String(started.result)}`);
  running = started.result;
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide, era === "legacy" ? { prior: { kind: "legacy" } } : {});
  return { client, started };
}

describe("docseal-mcp", () => {
  it("prints help and the version without serving", () => {
    expect(run(["--help"])).toMatchObject({ result: 0, stdout: USAGE, stderr: "" });
    expect(run(["-v"])).toMatchObject({ result: 0, stdout: `${VERSION}\n`, stderr: "" });
  });

  it.each([
    [["--unknown"], "Unknown option"],
    [["stray"], "positional"],
    [["--allow-seal"], "--allow-seal and --key go together"],
    [["--key", "a.key"], "--allow-seal and --key go together"],
    [["--offline", "--chain", "https://example.org/api"], "contradict"],
  ])("refuses %j before serving", (argv, message) => {
    const { result, stdout, stderr } = run(argv);
    expect(result).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(message);
    expect(stderr).toContain("Usage: docseal-mcp");
  });

  it.each(["modern", "legacy"] as const)("serves a %s client with its name, version, and tool list", async (era) => {
    const { client } = await connect([], era);
    expect(client.getServerVersion()).toMatchObject({ name: NAME, version: VERSION });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["verify", "inspect"]);
  });

  it("writes nothing to stdout while serving and says on stderr what it allows", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    const { client, started } = await connect(["--root", "/srv/docs", "--allow-seal", "--key", "a.key"]);
    await client.listTools();
    expect(started.stdout).toBe("");
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(started.stderr).toBe(`${NAME} ${VERSION}: serving on stdio; files under /srv/docs; sealing on\n`);
  });

  it("says when it has no file access", async () => {
    const { started } = await connect();
    expect(started.stderr).toContain("no file access (no --root); sealing off");
  });
});
