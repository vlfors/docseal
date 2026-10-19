import { describe, expect, it } from "vitest";
import { canStreamToDisk, suggestedName } from "./limits";

describe("saving", () => {
  it("suggests the document's name for one document", () => {
    expect(suggestedName(["contract.pdf"])).toBe("contract.dseal");
    expect(suggestedName(["dir/.hidden"])).toBe(".hidden.dseal");
    expect(suggestedName(["a.txt", "b.txt"])).toBe("package.dseal");
  });

  it("streams only where the File System Access API is there", () => {
    expect(canStreamToDisk({ showSaveFilePicker: () => Promise.resolve() })).toBe(true);
    expect(canStreamToDisk({})).toBe(false);
  });
});
