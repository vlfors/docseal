import type { AnchorReport } from "@docseal/core";
import { describe, expect, it } from "vitest";
import { minutesLeft, progressOf, stageOf, submittedAt } from "./proof";

const anchor = (fields: Partial<AnchorReport>): AnchorReport => ({
  entry: "anchors/seal-1.json",
  provider: "opentimestamps",
  network: "bip122:000000000019d6689c085ae165831e93",
  verdict: "pending",
  ...fields,
});

describe("time proof progress", () => {
  it("is only sent while no proof has reached a block", () => {
    const progress = progressOf([anchor({ submittedAt: "2026-10-20T10:00:00Z" })]);
    expect(progress).toEqual({ confirmed: false });
    expect(stageOf(progress)).toBe("submitted");
    expect(minutesLeft(progress, 6)).toBeUndefined();
  });

  it("follows the deepest proof in a block, and tells about how long the rest takes", () => {
    const progress = progressOf([
      anchor({ blockHeight: 900_001, confirmations: 1 }),
      anchor({ blockHeight: 900_000, confirmations: 2 }),
      anchor({ verdict: "unsupported" }),
    ]);
    expect(progress).toEqual({ confirmed: false, blockHeight: 900_000, confirmations: 2 });
    expect(stageOf(progress)).toBe("in-block");
    expect(minutesLeft(progress, 6)).toBe(40);
  });

  it("is confirmed once any proof is", () => {
    const progress = progressOf([anchor({ verdict: "confirmed", blockHeight: 900_000, confirmations: 9 }), anchor({})]);
    expect(stageOf(progress)).toBe("confirmed");
    expect(minutesLeft(progress, 6)).toBeUndefined();
  });

  it("takes the earliest readable submission time", () => {
    expect(submittedAt([anchor({ submittedAt: "not a time" }), anchor({ submittedAt: "2026-10-20T12:00:00Z" }), anchor({ submittedAt: "2026-10-20T10:00:00Z" })])).toEqual(
      new Date("2026-10-20T10:00:00Z"),
    );
    expect(submittedAt([anchor({})])).toBeUndefined();
  });
});
