import { describe, expect, it } from "vitest";
import { canStreamToDisk, memoryLimit, suggestedName } from "./limits";

describe("saving", () => {
  it("suggests the document's name for one document", () => {
    expect(suggestedName(["contract.pdf"])).toBe("contract.dseal");
    expect(suggestedName(["dir/.hidden"])).toBe(".hidden.dseal");
    expect(suggestedName(["a.txt", "b.txt"])).toBe("package.dseal");
  });

  it("allows Firefox more memory than other engines", () => {
    expect(memoryLimit("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe(2 * 1024 ** 3);
    expect(memoryLimit("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe(1024 ** 3);
  });

  it("streams only where the File System Access API is there", () => {
    expect(canStreamToDisk({ showSaveFilePicker: () => Promise.resolve() })).toBe(true);
    expect(canStreamToDisk({})).toBe(false);
  });
});
