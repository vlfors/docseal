import { describe, expect, it } from "vitest";
import { FormatError } from "./errors.js";
import { parseAnchorFile, parseEnvelope, parseManifest, parseStatement } from "./model.js";

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

const HASH = "ab".repeat(32);
const SALT = "cd".repeat(16);
const UUID = "urn:uuid:3b0c4f8e-6a1d-4c2b-9f57-0d1e2a3b4c5d";
const DELETE = Symbol("delete");

const valid = {
  manifest: () => ({
    type: "docseal-manifest",
    version: 1,
    packageId: UUID,
    hashAlgorithm: "sha-256",
    merkleScheme: "docseal-v1",
    metadata: { title: "t" },
    generator: "g",
    files: [
      { path: "a.txt", size: 1, hash: HASH, salt: SALT, mediaType: "text/plain" },
      { path: "b.txt", size: 0, hash: HASH, salt: SALT },
    ],
  }),
  statement: () => statement("2026-10-16T12:00:00Z"),
  envelope: () => ({
    protected: {
      type: "docseal-signature",
      version: 1,
      suite: "ed25519",
      profile: "docseal-ed25519-v1",
      signer: "did:key:z6Mk",
      role: "author",
      claimedAt: "2026-10-16T12:00:00Z",
      statementHash: HASH,
      attributes: { x: 1 },
      critical: [],
    },
    value: "AA",
  }),
  anchor: () => ({
    type: "docseal-anchor",
    version: 1,
    seal: HASH,
    statementHash: HASH,
    envelopes: [HASH, HASH],
    receipts: [
      { provider: "p", network: "n", digestAlgorithm: "sha-256", digest: HASH, proof: "AA", cached: { a: 1 } },
      { provider: "p", network: "n", digestAlgorithm: "sha-256", digest: HASH, proof: "AA" },
    ],
  }),
};
type Kind = keyof typeof valid;
const parsers: Record<Kind, (value: unknown) => unknown> = {
  manifest: parseManifest,
  statement: parseStatement,
  envelope: parseEnvelope,
  anchor: parseAnchorFile,
};

/** Sets (or deletes) the member at `path` in a fresh valid document. */
function edited(kind: Kind, path: (string | number)[], value: unknown): unknown {
  const root: unknown = valid[kind]();
  if (path.length === 0) return value;
  let target = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string | number, unknown>;
  const last = path.at(-1) ?? "";
  if (value === DELETE) Reflect.deleteProperty(target, last);
  else target[last] = value;
  return root;
}

describe("document parsers", () => {
  it.each(Object.keys(valid) as Kind[])("accept a valid %s, with and without optional members", (kind) => {
    expect(() => parsers[kind](valid[kind]())).not.toThrow();
    for (const [k, path] of [
      ["manifest", ["metadata"]],
      ["manifest", ["generator"]],
      ["manifest", ["files", 0, "mediaType"]],
      ["envelope", ["protected", "role"]],
      ["envelope", ["protected", "attributes"]],
      ["anchor", ["receipts", 0, "cached"]],
    ] as const) {
      if (k === kind) expect(() => parsers[kind](edited(kind, [...path], DELETE))).not.toThrow();
    }
  });

  // [document, member path, new value, field named in the error, verdict]
  const cases: [Kind, (string | number)[], unknown, string, "invalid" | "unsupported"][] = [
    ["manifest", [], [], "manifest", "invalid"],
    ["manifest", [], null, "manifest", "invalid"],
    ["manifest", [], "x", "manifest", "invalid"],
    ["manifest", ["type"], "docseal-statement", "manifest.type", "invalid"],
    ["manifest", ["version"], 2, "manifest.version", "unsupported"],
    ["manifest", ["packageId"], UUID.toUpperCase(), "manifest.packageId", "invalid"],
    ["manifest", ["packageId"], `x${UUID}`, "manifest.packageId", "invalid"],
    ["manifest", ["packageId"], `${UUID}0`, "manifest.packageId", "invalid"],
    ["manifest", ["packageId"], 1, "manifest.packageId", "invalid"],
    ["manifest", ["packageId"], [UUID], "manifest.packageId", "invalid"],
    ["manifest", ["hashAlgorithm"], "sha-512", "manifest.hashAlgorithm", "unsupported"],
    ["manifest", ["merkleScheme"], "docseal-v2", "manifest.merkleScheme", "unsupported"],
    ["manifest", ["metadata"], [], "manifest.metadata", "invalid"],
    ["manifest", ["metadata"], null, "manifest.metadata", "invalid"],
    ["manifest", ["generator"], 1, "manifest.generator", "invalid"],
    ["manifest", ["files"], {}, "manifest.files", "invalid"],
    ["manifest", ["files"], [], "manifest.files", "invalid"],
    ["manifest", ["files", 1], "b.txt", "manifest.files[1]", "invalid"],
    ["manifest", ["files", 1, "path"], 1, "manifest.files[1].path", "invalid"],
    ["manifest", ["files", 1, "path"], "a.txt", "manifest.files[1].path", "invalid"],
    ["manifest", ["files", 1, "path"], "0.txt", "manifest.files[1].path", "invalid"],
    ["manifest", ["files", 1, "size"], -1, "manifest.files[1].size", "invalid"],
    ["manifest", ["files", 1, "size"], 0.5, "manifest.files[1].size", "invalid"],
    ["manifest", ["files", 1, "size"], 2 ** 53, "manifest.files[1].size", "invalid"],
    ["manifest", ["files", 1, "size"], "1", "manifest.files[1].size", "invalid"],
    ["manifest", ["files", 1, "hash"], HASH.toUpperCase(), "manifest.files[1].hash", "invalid"],
    ["manifest", ["files", 1, "hash"], `${HASH}00`, "manifest.files[1].hash", "invalid"],
    ["manifest", ["files", 1, "hash"], `0${HASH}`, "manifest.files[1].hash", "invalid"],
    ["manifest", ["files", 1, "hash"], 1, "manifest.files[1].hash", "invalid"],
    ["manifest", ["files", 1, "hash"], [HASH], "manifest.files[1].hash", "invalid"],
    ["manifest", ["files", 1, "salt"], HASH, "manifest.files[1].salt", "invalid"],
    ["manifest", ["files", 1, "mediaType"], 1, "manifest.files[1].mediaType", "invalid"],
    ["statement", ["type"], "docseal-manifest", "statement.type", "invalid"],
    ["statement", ["version"], 2, "statement.version", "unsupported"],
    ["statement", ["critical"], ["x"], "statement.critical", "unsupported"],
    ["statement", ["critical"], "x", "statement.critical", "invalid"],
    ["statement", ["critical"], [1], "statement.critical[0]", "invalid"],
    ["statement", ["packageId"], "x", "statement.packageId", "invalid"],
    ["statement", ["hashAlgorithm"], "sha-512", "statement.hashAlgorithm", "unsupported"],
    ["statement", ["merkleScheme"], "x", "statement.merkleScheme", "unsupported"],
    ["statement", ["merkleRoot"], "00", "statement.merkleRoot", "invalid"],
    ["statement", ["manifestHash"], "00", "statement.manifestHash", "invalid"],
    ["statement", ["createdAt"], 1, "statement.createdAt", "invalid"],
    ["statement", ["previous"], HASH, "statement.previous", "unsupported"],
    ["statement", ["previous"], DELETE, "statement.previous", "unsupported"],
    ["statement", ["signaturePolicy"], "any-valid", "statement.signaturePolicy", "invalid"],
    ["statement", ["signaturePolicy", "type"], "all", "statement.signaturePolicy.type", "unsupported"],
    ["envelope", [], [], "envelope", "invalid"],
    ["envelope", ["value"], 1, "envelope.value", "invalid"],
    ["envelope", ["protected"], [], "envelope.protected", "invalid"],
    ["envelope", ["protected", "type"], "docseal-anchor", "envelope.protected.type", "invalid"],
    ["envelope", ["protected", "version"], 2, "envelope.protected.version", "unsupported"],
    ["envelope", ["protected", "suite"], 1, "envelope.protected.suite", "invalid"],
    ["envelope", ["protected", "profile"], DELETE, "envelope.protected.profile", "invalid"],
    ["envelope", ["protected", "signer"], null, "envelope.protected.signer", "invalid"],
    ["envelope", ["protected", "role"], 1, "envelope.protected.role", "invalid"],
    ["envelope", ["protected", "claimedAt"], "2026-10-16", "envelope.protected.claimedAt", "invalid"],
    ["envelope", ["protected", "statementHash"], "00", "envelope.protected.statementHash", "invalid"],
    ["envelope", ["protected", "attributes"], "x", "envelope.protected.attributes", "invalid"],
    ["envelope", ["protected", "critical"], DELETE, "envelope.protected.critical", "invalid"],
    ["envelope", ["protected", "critical"], [null], "envelope.protected.critical[0]", "invalid"],
    ["anchor", [], "x", "anchor", "invalid"],
    ["anchor", ["type"], "docseal-signature", "anchor.type", "invalid"],
    ["anchor", ["version"], 2, "anchor.version", "unsupported"],
    ["anchor", ["seal"], "00", "anchor.seal", "invalid"],
    ["anchor", ["statementHash"], DELETE, "anchor.statementHash", "invalid"],
    ["anchor", ["envelopes"], HASH, "anchor.envelopes", "invalid"],
    ["anchor", ["envelopes", 1], "00", "anchor.envelopes[1]", "invalid"],
    ["anchor", ["receipts"], {}, "anchor.receipts", "invalid"],
    ["anchor", ["receipts"], [], "anchor.receipts", "invalid"],
    ["anchor", ["receipts", 1], null, "anchor.receipts[1]", "invalid"],
    ["anchor", ["receipts", 1, "provider"], 1, "anchor.receipts[1].provider", "invalid"],
    ["anchor", ["receipts", 1, "network"], DELETE, "anchor.receipts[1].network", "invalid"],
    ["anchor", ["receipts", 1, "digestAlgorithm"], "sha-512", "anchor.receipts[1].digestAlgorithm", "unsupported"],
    ["anchor", ["receipts", 1, "digest"], "00", "anchor.receipts[1].digest", "invalid"],
    ["anchor", ["receipts", 1, "proof"], 1, "anchor.receipts[1].proof", "invalid"],
    ["anchor", ["receipts", 1, "cached"], [], "anchor.receipts[1].cached", "invalid"],
  ];

  it.each(cases)("reject %s %j = %j (%s, %s)", (kind, path, value, where, verdict) => {
    let error: unknown;
    try {
      parsers[kind](edited(kind, path, value));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(FormatError);
    const { code, message, verdict: actual } = error as FormatError;
    expect({ code, verdict: actual }).toEqual({ code: verdict === "invalid" ? "schema" : "unsupported", verdict });
    expect(message).toMatch(new RegExp(`^${where.replace(/[.[\]]/g, "\\$&")}: \\S`));
  });

  it("names every unknown critical extension", () => {
    expect(() => parseStatement(edited("statement", ["critical"], ["x-a", "x-b"]))).toThrow("statement.critical: unknown critical extensions: x-a, x-b");
  });
});

describe("FormatError", () => {
  it("is named, and invalid unless said otherwise", () => {
    const error = new FormatError("c", "m");
    expect({ name: error.name, code: error.code, message: error.message, verdict: error.verdict }).toEqual({ name: "FormatError", code: "c", message: "m", verdict: "invalid" });
  });
});
