import { describe, expect, it } from "vitest";
import { FormatError } from "./errors.js";
import { parseStatement } from "./model.js";

const statement = (createdAt: string) => ({
  type: "docseal-package-statement",
  version: 1,
  packageId: "urn:uuid:3b0c4f8e-6a1d-4c2b-9f57-0d1e2a3b4c5d",
  hashAlgorithm: "sha-256",
  merkleScheme: "docseal-v1",
  merkleRoot: "00".repeat(32),
  manifestHash: "00".repeat(32),
  createdAt,
  previous: null,
  signaturePolicy: { type: "any-valid" },
  critical: [],
});

describe("timestamps", () => {
  it.each(["2026-10-16T12:00:00Z", "2024-02-29T23:59:59Z", "2000-02-29T00:00:00.123Z", "0001-01-01T00:00:00Z"])("accepts %s", (t) => {
    expect(() => parseStatement(statement(t))).not.toThrow();
  });

  it.each([
    "2026-02-29T00:00:00Z", // not a leap year
    "1900-02-29T00:00:00Z", // century, not a leap year
    "2026-02-30T12:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-10-16T24:00:00Z",
    "2026-10-16T23:60:00Z",
    "2026-12-31T23:59:60Z", // leap second
    "2026-10-16T12:00:00+00:00",
    "2026-10-16 12:00:00Z",
    "2026-10-16T12:00:00z",
  ])("rejects %s", (t) => {
    expect(() => parseStatement(statement(t))).toThrow(FormatError);
  });
});
