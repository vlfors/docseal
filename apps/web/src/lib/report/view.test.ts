import { readFileSync } from "node:fs";
import { verifyPackage, type AxisVerdicts, type VerificationReport } from "@docseal/core";
import { openTimestamps } from "@docseal/anchor-ots";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { describe, expect, it } from "vitest";
import { AXES, viewReport } from "./view";

const PACKAGES = new URL("../../../../../spec/vectors/packages/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("expected.json", PACKAGES), "utf8")) as {
  packages: { file: string; expected: { axes: AxisVerdicts; overall: string } }[];
};

async function verify(file: string): Promise<VerificationReport> {
  return verifyPackage(new Uint8Array(readFileSync(new URL(file, PACKAGES))), { suites: [ed25519Suite()], anchors: [openTimestamps()] });
}

describe("viewReport", () => {
  it.each(index.packages)("$file shows the verdicts its vector requires and every reason", async ({ file, expected }) => {
    const report = await verify(file);
    const view = viewReport(report);
    expect(view.overall).toBe(expected.overall);
    expect(Object.fromEntries(view.axes.map((row) => [row.axis, row.verdict]))).toEqual(expected.axes);
    expect(view.axes.map((row) => row.axis)).toEqual(AXES);
    // Every issue the verifier found is shown, except a pending proof, which is the time row.
    expect(view.issues).toEqual(report.issues.filter((issue) => issue.code !== "pending"));
    expect(view.problemFiles).toEqual(report.files.filter((f) => f.status !== "valid"));
    if (expected.overall === "invalid") {
      expect(view.axes.some((row) => row.tone === "bad"), "an invalid package shows which axis failed").toBe(true);
      expect(view.issues.length, "an invalid package shows why").toBeGreaterThan(0);
    }
  });

  it("marks only the strongest value of each axis as good", async () => {
    const view = viewReport(await verify("valid-basic.dseal"));
    expect(Object.fromEntries(view.axes.map((row) => [row.axis, row.tone]))).toEqual({
      format: "good",
      integrity: "good",
      signature: "good",
      trust: "neutral",
      time: "neutral",
      completeness: "good",
    });
    const tampered = viewReport(await verify("tampered-content.dseal"));
    expect(tampered.axes.find((row) => row.axis === "integrity")?.tone).toBe("bad");
  });

  it("gives the details of each axis", async () => {
    const view = viewReport(await verify("tampered-content.dseal"));
    expect(view.axes.find((row) => row.axis === "integrity")?.detail).toMatchObject({ kind: "files", total: 3 });
    const signers = viewReport(await verify("valid-two-signers-pending-anchor.dseal")).axes.find((row) => row.axis === "signature")?.detail;
    expect(signers?.kind === "signers" && signers.signers.length).toBe(2);
  });

  it("sets apart an unchanged, correctly signed package from what it does not confirm", async () => {
    const basic = viewReport(await verify("valid-basic.dseal"));
    expect(basic.overall).toBe("indeterminate");
    expect(basic.authentic).toBe(true);
    expect(basic.unconfirmed).toEqual(["trust", "time"]);
    const tampered = viewReport(await verify("tampered-content.dseal"));
    expect(tampered.authentic).toBe(false);
    expect(tampered.unconfirmed).toEqual([]);
  });

  it("suggests next steps like the CLI, but never a time proof for a package that is not well-formed", async () => {
    expect(viewReport(await verify("valid-basic.dseal")).hints).toEqual(["trustNotEvaluated", "timeMissing"]);
    expect(viewReport(await verify("valid-pending-anchor.dseal")).hints).toEqual(["trustNotEvaluated", "timeOffline"]);
    expect(viewReport(await verify("valid-pending-anchor.dseal"), { online: true }).hints).toEqual(["trustNotEvaluated", "timeUnsupported"]);
    expect(viewReport(await verify("crc-mismatch.dseal")).hints).toEqual([]);
  });
});
