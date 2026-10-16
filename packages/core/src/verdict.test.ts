import { describe, expect, it } from "vitest";
import { overallVerdict, type AxisVerdicts } from "./verdict.js";

const allValid: AxisVerdicts = {
  format: "valid",
  integrity: "valid",
  signature: "valid",
  trust: "trusted",
  time: "confirmed",
  completeness: "full",
};

describe("overallVerdict", () => {
  it("is valid only when every axis is at its strongest value", () => {
    expect(overallVerdict(allValid)).toBe("valid");
  });

  it.each<Partial<AxisVerdicts>>([
    { format: "invalid" },
    { integrity: "invalid" },
    { signature: "invalid" },
    { time: "invalid" },
    { trust: "untrusted", integrity: "invalid" },
  ])("is invalid for %j", (override) => {
    expect(overallVerdict({ ...allValid, ...override })).toBe("invalid");
  });

  it.each<Partial<AxisVerdicts>>([
    { format: "unsupported" },
    { integrity: "not-checked" },
    { signature: "unsupported" },
    { signature: "missing" },
    { trust: "untrusted" },
    { trust: "unknown" },
    { trust: "not-evaluated" },
    { time: "pending" },
    { time: "unsupported" },
    { time: "missing" },
    { completeness: "partial" },
    { completeness: "incomplete" },
  ])("is indeterminate for %j", (override) => {
    expect(overallVerdict({ ...allValid, ...override })).toBe("indeterminate");
  });
});
