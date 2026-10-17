/**
 * The full report for every golden package: issues (axis, code, subject, message), file,
 * signature, and anchor results. The vectors pin only the verdicts, which every implementation
 * must reproduce; the rest of the report is this implementation's API, pinned here so that a
 * change to it is deliberate. Update with `vitest run tests/reports.test.ts -u`.
 */
import { readFileSync } from "node:fs";
import { verifyPackage } from "@docseal/core";
import { openTimestamps } from "@docseal/anchor-ots";
import { ed25519Suite } from "@docseal/sig-ed25519";
import { describe, expect, it } from "vitest";

const PACKAGES = new URL("../spec/vectors/packages/", import.meta.url);
const index = JSON.parse(readFileSync(new URL("expected.json", PACKAGES), "utf8")) as { packages: { file: string }[] };

/** Long strings (the 100 000-digit signer) are shortened so the snapshot stays readable. */
const shorten = (value: unknown): unknown =>
  typeof value === "string" && value.length > 120
    ? `${value.slice(0, 60)}…(${String(value.length)} characters)`
    : Array.isArray(value)
      ? value.map(shorten)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]))
        : value;

describe("verification reports of the golden packages", () => {
  it.each(index.packages.map((p) => p.file))("%s", async (file) => {
    const report = await verifyPackage(new Uint8Array(readFileSync(new URL(file, PACKAGES))), { suites: [ed25519Suite()], anchors: [openTimestamps()] });
    expect(shorten(report)).toMatchSnapshot();
  });
});
