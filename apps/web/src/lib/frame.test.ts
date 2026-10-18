import { describe, expect, it } from "vitest";
import { isFramed } from "./frame";

describe("isFramed", () => {
  it("is false for a top-level page and true inside a frame", () => {
    const self = {};
    expect(isFramed({ self, top: self })).toBe(false);
    expect(isFramed({ self, top: {} })).toBe(true);
  });

  it("treats an unreadable top window as a frame", () => {
    const window = {
      self: {},
      get top(): object {
        throw new DOMException("cross-origin", "SecurityError");
      },
    };
    expect(isFramed(window)).toBe(true);
  });
});
