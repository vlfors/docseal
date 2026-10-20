import { describe, expect, it } from "vitest";
import { isEsploraUrl, parseChoice, toSetting } from "./setting";

describe("chain setting", () => {
  it("accepts https, and http only to this computer", () => {
    expect(isEsploraUrl("https://mempool.example/api")).toBe(true);
    expect(isEsploraUrl("http://localhost:3002/api")).toBe(true);
    expect(isEsploraUrl("http://127.0.0.1:3002")).toBe(true);
    expect(isEsploraUrl("http://mempool.example/api")).toBe(false);
    expect(isEsploraUrl("https://user:pass@mempool.example")).toBe(false);
    expect(isEsploraUrl("https://mempool.example/api?x=1")).toBe(false);
    expect(isEsploraUrl("javascript:alert(1)")).toBe(false);
    expect(isEsploraUrl("not a url")).toBe(false);
  });

  it("maps a choice to the sources the worker asks", () => {
    expect(toSetting({ mode: "public", url: "" })).toEqual({ kind: "esplora", urls: ["https://mempool.space/api", "https://blockstream.info/api"] });
    expect(toSetting({ mode: "custom", url: "https://e.example/api" })).toEqual({ kind: "esplora", urls: ["https://e.example/api"] });
    // An unusable address checks nothing rather than something unexpected.
    expect(toSetting({ mode: "custom", url: "http://e.example" })).toEqual({ kind: "offline" });
    expect(toSetting({ mode: "offline", url: "https://e.example" })).toEqual({ kind: "offline" });
  });

  it("reads a stored choice, falling back to the public sources", () => {
    expect(parseChoice(null)).toEqual({ mode: "public", url: "" });
    expect(parseChoice('{"mode":"custom","url":"https://e.example"}')).toEqual({ mode: "custom", url: "https://e.example" });
    expect(parseChoice('{"mode":"weird"}')).toEqual({ mode: "public", url: "" });
    expect(parseChoice("{broken")).toEqual({ mode: "public", url: "" });
  });
});
