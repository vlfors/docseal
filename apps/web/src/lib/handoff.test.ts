import { describe, expect, it } from "vitest";
import { handOver, takeHanded } from "./handoff";

describe("handOver", () => {
  it("gives the package to the next page once", () => {
    const file = new File(["x"], "a.dseal");
    handOver(file);
    expect(takeHanded()).toBe(file);
    expect(takeHanded()).toBeUndefined();
  });
});
