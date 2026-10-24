import { copyFile, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main as cli } from "../../cli/src/main.js";
import { HEIGHT, fakeNetwork } from "../../../tests/fake-network.js";
import { main, type Running } from "./main.js";
import type { UpgradeOutput, VerifyOutput } from "./schemas.js";

const GOLDEN = join(import.meta.dirname, "../../../spec/vectors/packages");
const PENDING = "valid-pending-anchor.dseal";

let dir: string;
let network: ReturnType<typeof fakeNetwork>;
let running: Running | undefined;
let client: Client | undefined;
const path = (name: string) => join(dir, name);

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "docseal-mcp-upgrade-")));
  network = fakeNetwork();
  await copyFile(join(GOLDEN, PENDING), path(PENDING));
  await copyFile(join(GOLDEN, "valid-basic.dseal"), path("no-proof.dseal"));
});

afterEach(async () => {
  await client?.close();
  await running?.close();
  client = running = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function connect(extra: string[] = ["--chain", "https://esplora.test"]): Promise<void> {
  await client?.close();
  await running?.close();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const started = main(["--root", dir, ...extra], { stdout: () => undefined, stderr: () => undefined, transport: serverSide, fetch: network.fetch });
  if (typeof started === "number") throw new Error("not serving");
  running = started;
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (!client) throw new Error("not connected");
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as T;
}

describe("upgrade", () => {
  it("leaves a package alone until the calendars have a completed proof", async () => {
    await connect();
    const before = await readFile(path(PENDING));
    const out = await call<UpgradeOutput>("upgrade", { path: PENDING });
    expect(out).toMatchObject({ changed: false, stage: "submitted", requiredConfirmations: 6 });
    expect(out.written).toBeUndefined();
    expect(out.summary).toBe(
      "No change: the calendars have no completed proof yet. The time proof was sent to the calendars and is not in a Bitcoin block yet.",
    );
    expect(out.nextSteps).toEqual(["Call upgrade again in a few hours: calendars usually complete a proof within a few hours."]);
    expect(await readFile(path(PENDING))).toEqual(before);
    expect((await readdir(dir)).sort()).toEqual(["no-proof.dseal", PENDING]);
  });

  it("writes the completed proof next to the original, the same bytes as docseal upgrade", async () => {
    await connect();
    const original = await readFile(path(PENDING));
    network.confirm();
    const out = await call<UpgradeOutput>("upgrade", { path: PENDING });
    const upgraded = path("valid-pending-anchor.upgraded.dseal");
    expect(out).toEqual({
      summary: "Upgraded: the completed proof was written to a new file. The time proof is confirmed by Bitcoin.",
      changed: true,
      written: upgraded,
      stage: "confirmed",
      blockHeight: HEIGHT,
      confirmations: 10,
      requiredConfirmations: 6,
      nextSteps: ["Use the upgraded file from now on: call verify on it, and send it rather than the original."],
    });
    expect(await readFile(path(PENDING))).toEqual(original);
    expect((await readdir(dir)).sort()).toEqual(["no-proof.dseal", PENDING, "valid-pending-anchor.upgraded.dseal"]);

    const verified = await call<VerifyOutput>("verify", { path: upgraded });
    expect(verified.report.axes).toMatchObject({ integrity: "valid", signature: "valid", time: "confirmed", completeness: "full" });

    const code = await cli(["upgrade", path(PENDING), "-o", path("by-cli.dseal")], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: {},
      fetch: network.fetch,
      readSecret: () => Promise.reject(new Error("no terminal")),
    });
    expect(code).toBe(0);
    expect(await readFile(upgraded)).toEqual(await readFile(path("by-cli.dseal")));

    // Again: the earlier upgraded file is replaced; the upgraded file itself needs nothing more.
    expect(await call<UpgradeOutput>("upgrade", { path: PENDING })).toMatchObject({ changed: true, written: upgraded });
    expect(await call<UpgradeOutput>("upgrade", { path: upgraded })).toMatchObject({ changed: false, stage: "confirmed" });
  });

  it("replaces the original only with overwrite", async () => {
    await connect();
    network.confirm();
    const out = await call<UpgradeOutput>("upgrade", { path: PENDING, overwrite: true });
    expect(out).toMatchObject({ changed: true, written: path(PENDING), stage: "confirmed" });
    expect((await readdir(dir)).sort()).toEqual(["no-proof.dseal", PENDING]);
    expect((await call<VerifyOutput>("verify", { path: PENDING })).report.axes.time).toBe("confirmed");
  });

  it("still asks the calendars when offline, but cannot count confirmations", async () => {
    await connect(["--offline"]);
    network.confirm();
    const out = await call<UpgradeOutput>("upgrade", { path: PENDING });
    expect(out).toMatchObject({ changed: true, stage: "in-block" });
    expect(out.confirmations).toBeUndefined();
    expect(out.nextSteps[0]).toContain("The server runs offline");
    expect(network.requests.some((request) => request.includes("esplora.test"))).toBe(false);
  });

  it("says when a package has no time proof", async () => {
    await connect();
    expect(await call<UpgradeOutput>("upgrade", { path: "no-proof.dseal" })).toMatchObject({ changed: false, stage: "none", nextSteps: [] });
    expect(network.requests).toEqual([]);
  });

  it("refuses a package outside the roots", async () => {
    await connect();
    await expect(call("upgrade", { path: join(GOLDEN, PENDING) })).rejects.toThrow("outside the directories");
  });
});
