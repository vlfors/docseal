import { describe, expect, it } from "vitest";
import { browserFetch, mayContact, NotAllowed } from "./network";

describe("browserFetch", () => {
  it("sends only simple requests: no User-Agent, no credentials, no referrer", async () => {
    const seen: RequestInit[] = [];
    const fetch = browserFetch((_, init) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response("ok"));
    });
    await fetch("https://a.pool.opentimestamps.org/digest", { method: "POST", headers: { Accept: "application/vnd.opentimestamps.v1", "User-Agent": "docseal" } });
    const init = seen[0] ?? {};
    const headers = new Headers(init.headers);
    expect(headers.has("user-agent")).toBe(false);
    expect(headers.get("accept")).toBe("application/vnd.opentimestamps.v1");
    expect(init).toMatchObject({ mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  });

  it("records the calendars that accepted a digest", async () => {
    const fetch = browserFetch((url) => Promise.resolve(new Response("x", { status: url.includes("b.pool") ? 500 : 200 })));
    await fetch("https://a.pool.opentimestamps.org/digest", { method: "POST" });
    await fetch("https://b.pool.opentimestamps.org/digest", { method: "POST" });
    await fetch("https://mempool.space/api/blocks/tip/height");
    expect(fetch.acceptedCalendars).toEqual(["https://a.pool.opentimestamps.org"]);
  });

  it("reads an unreadable upgrade answer as not committed yet, and nothing else", async () => {
    const fetch = browserFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const upgrade = await fetch(`https://alice.btc.calendar.opentimestamps.org/timestamp/${"ab".repeat(32)}`);
    expect(upgrade.status).toBe(404);
    await expect(fetch("https://a.pool.opentimestamps.org/digest", { method: "POST" })).rejects.toThrow(TypeError);
    await expect(fetch("https://mempool.space/api/blocks/tip/height")).rejects.toThrow(TypeError);
    const timeout = browserFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    await expect(timeout(`https://alice.btc.calendar.opentimestamps.org/timestamp/${"ab".repeat(32)}`)).rejects.toThrow("timed out");
  });

  it("is the workers' connect-src: only the sources of network.js, and the viewer's own", async () => {
    expect(mayContact("https://a.pool.opentimestamps.org/digest")).toBe(true);
    expect(mayContact("https://alice.btc.calendar.opentimestamps.org/timestamp/ab")).toBe(true);
    expect(mayContact("https://mempool.space/api/blocks/tip/height")).toBe(true);
    expect(mayContact("https://ots.btc.catallaxy.com/digest")).toBe(false);
    expect(mayContact("https://evil.example/collect")).toBe(false);
    expect(mayContact("https://calendar.opentimestamps.org.evil.example/x")).toBe(false);
    expect(mayContact("http://mempool.space/api")).toBe(false);
    expect(mayContact("http://localhost:3002/api/blocks/tip/height", ["http://localhost:3002"])).toBe(true);
    let called = false;
    const fetch = browserFetch(() => {
      called = true;
      return Promise.resolve(new Response("x"));
    });
    await expect(fetch("https://evil.example/collect", { method: "POST" })).rejects.toBeInstanceOf(NotAllowed);
    expect(called).toBe(false);
  });
});
