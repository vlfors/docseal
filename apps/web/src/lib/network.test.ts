import { describe, expect, it } from "vitest";
import { browserFetch } from "./network";

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
});
