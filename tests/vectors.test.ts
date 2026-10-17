/**
 * Language-neutral test vectors in spec/vectors/.
 *
 * JSON vectors are regenerated on every run and must equal the committed files byte for byte,
 * so a code change that alters the format fails here. Golden packages are fixed artifacts:
 * they are only written with UPDATE_VECTORS=1, and every run verifies the committed files.
 * UPDATE_VECTORS=missing writes only golden packages that do not exist yet, so the existing
 * ones stay byte for byte as they were (some were made by another ZIP writer, on purpose).
 *
 *   UPDATE_VECTORS=1 pnpm vitest run tests/vectors.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  checkPathCollisions,
  comparePaths,
  crc32,
  fromHex,
  hash,
  jcs,
  jsonHash,
  leafHash,
  merkleRoot,
  parseJson,
  readContainer,
  sealDigest,
  sealPackage,
  signaturesSetHash,
  signedBytes,
  toBase64url,
  toHex,
  utf8,
  validatePath,
  verifyPackage,
  writeContainer,
  type AnchorProvider,
  type AxisVerdicts,
  type OverallVerdict,
  type PackageContents,
  type ProtectedHeader,
  type SignatureEnvelope,
} from "@docseal/core";
import { BITCOIN_MAINNET, openTimestamps, serializeDetached } from "@docseal/anchor-ots";
import { PROFILE_ID, ed25519Suite, memoryKeyProvider, publicKeyToDid } from "@docseal/sig-ed25519";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

const VECTORS = new URL("../spec/vectors/", import.meta.url);
const SCHEMAS = new URL("../spec/schemas/", import.meta.url);
const UPDATE = process.env.UPDATE_VECTORS === "1";
const ADD_MISSING = UPDATE || process.env.UPDATE_VECTORS === "missing";

// RFC 8032 §7.1 TEST 1 secret key, so signatures can be cross-checked against the RFC.
const SEED = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const SECOND_SEED = hash(utf8("docseal test vectors: second signer"));
const NOW = new Date("2026-10-16T12:00:00Z");

/** Deterministic "randomness": SHA-256 of a label and a counter. */
function seeded(label: string): (length: number) => Uint8Array {
  let counter = 0;
  return (length) => hash(utf8(`${label}/${String(counter++)}`)).slice(0, length);
}

function writeOrCompare(name: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const file = new URL(name, VECTORS);
  if (ADD_MISSING) {
    mkdirSync(new URL(".", file), { recursive: true });
    writeFileSync(file, text);
  }
  expect(readFileSync(file, "utf8")).toBe(text);
}

// ---------------------------------------------------------------------------
// JCS

const JCS_INPUTS = [
  '{"b":2,"a":1}',
  '{"\\u20ac":"Euro","\\r":"CR","\\ufb33":"Hebrew","1":"One","\\ud83d\\ude00":"Smiley","\\u0080":"Ctrl","\\u00f6":"Latin"}',
  '["\\u0000\\u0008\\t\\n\\u000b\\f\\r\\u001f","\\"\\\\/","\\u007f\\u2028\\u2029","Подпись ✓"]',
  '[0, -0, -0.0, 1.0, 100, 4.50, 2e-3, 1E21, 1e+30, 0.0000001, 0.000001, 1e-7]',
  '[333333333.33333329, 1.5e300, 5e-324, 1.7976931348623157e308, 123456789012345680000, 9007199254740993]',
  '[true, false, null, [], {}, {"nested": {"z": [1, {"y": 2, "x": 1}]}}]',
];

function jcsVectors() {
  return {
    description:
      "RFC 8785 canonicalization. 'input' is JSON text; 'canonical' is the exact expected output. Numbers follow ECMAScript Number-to-String; integers beyond 2^53 are first rounded to the nearest double.",
    cases: JCS_INPUTS.map((input) => ({ input, canonical: new TextDecoder().decode(jcs(JSON.parse(input))) })),
  };
}

// ---------------------------------------------------------------------------
// Paths

const VALID_PATHS = ["a.txt", "dir/sub/file.txt", "Договор №17.pdf", "emoji 😀.txt", ".hidden", "a..b", "é.txt", "x".repeat(1024)];
const INVALID_PATHS: [string, string][] = [
  ["", "empty"],
  ["/abs", "leading slash"],
  ["trailing/", "trailing slash"],
  ["a//b", "empty segment"],
  ["../escape", "dot-dot segment"],
  ["a/../b", "dot-dot segment"],
  ["./a", "dot segment"],
  ["a\\b", "backslash"],
  ["nul\u0000", "NUL"],
  ["tab\t", "control character"],
  ["del\u007f", "DEL"],
  ["é.txt", "not NFC"],
  ["x".repeat(1025), "longer than 1024 UTF-8 bytes"],
  ["я".repeat(513), "longer than 1024 UTF-8 bytes"],
];
const SORT_INPUT = ["\u{1f600}", "｡", "b", "a/z", "a", "B", "é", "a-b", "a/b"];
const COLLISIONS: string[][] = [
  ["a.txt", "a.txt"],
  ["Readme.md", "README.md"],
  ["a", "a/b"],
  ["a/b", "A"],
  ["ΟΔΟΣ.txt", "οδος.txt"],
  ["straße.txt", "STRASSE.txt"],
  ["Äpfel.txt", "äpfel.txt"],
  ["a/b", "a/c", "ab"],
  ["a.txt", "a.txt.bak"],
];

function pathVectors() {
  const isValid = (path: string) => {
    try {
      validatePath(path);
      return true;
    } catch {
      return false;
    }
  };
  const collides = (paths: string[]) => {
    try {
      checkPathCollisions(paths);
      return false;
    } catch {
      return true;
    }
  };
  for (const path of VALID_PATHS) expect(isValid(path), path).toBe(true);
  for (const [path] of INVALID_PATHS) expect(isValid(path), path).toBe(false);
  return {
    description:
      "Path rules (FORMAT-v0.1 §Paths). 'valid'/'invalid' are stored paths as verifiers see them; 'sort' is UTF-8 byte order; 'collisions' says whether a set of paths must be rejected.",
    valid: VALID_PATHS,
    invalid: INVALID_PATHS.map(([path, reason]) => ({ path, reason })),
    sort: { input: SORT_INPUT, expected: [...SORT_INPUT].sort(comparePaths) },
    collisions: COLLISIONS.map((paths) => ({ paths, collides: collides(paths) })),
  };
}

// ---------------------------------------------------------------------------
// Merkle tree

function merkleCase(name: string, files: { path: string; content: string }[]) {
  const random = seeded(`merkle/${name}`);
  const entries = files.map((file) => {
    const data = utf8(file.content);
    return { path: file.path, size: data.length, hash: toHex(hash(data)), salt: toHex(random(16)) };
  });
  const leaves = entries.map(leafHash);
  return { name, files: entries, leafHashes: leaves.map(toHex), root: toHex(merkleRoot(leaves)) };
}

function merkleVectors() {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `file-${String(i)}.txt`, content: `content ${String(i)}` }));
  return {
    description:
      "Merkle tree docseal-v1: leaf = SHA-256(0x00 || JCS({path,size,hash,salt})), node = SHA-256(0x01 || left || right), split as RFC 6962 §2.1. Files are already in manifest order.",
    cases: [
      ...[1, 2, 3, 4, 5, 7, 8].map((n) => merkleCase(`${String(n)} leaves`, numbered(n))),
      merkleCase("unicode paths and an empty file", [
        { path: "annex/приложение.txt", content: "приложение" },
        { path: "empty", content: "" },
        { path: "Договор.txt", content: "текст" },
      ]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Signatures

const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const P = (1n << 255n) - 19n;
const le32 = (value: bigint) => fromHex(value.toString(16).padStart(64, "0")).reverse();
const fromLe = (bytes: Uint8Array) => BigInt(`0x${toHex(bytes.slice().reverse())}`);

/** y-coordinates of every point of order dividing 8, including non-canonical encodings p and p+1. */
export const SMALL_ORDER_Y = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

async function signatureVectors() {
  const did = publicKeyToDid(ed25519.getPublicKey(SEED));
  const header: ProtectedHeader = {
    type: "docseal-signature",
    version: 1,
    suite: "ed25519",
    profile: PROFILE_ID,
    signer: did,
    role: "author",
    claimedAt: "2026-10-16T12:00:00Z",
    statementHash: toHex(hash(utf8("example statement"))),
    attributes: { purpose: "approve", note: "Подпись ✓" },
    critical: [],
  };
  const bytes = signedBytes(header);
  const signature = ed25519.sign(bytes, SEED);
  const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(SEED);
  const zeroNonce = (rEncoding: Uint8Array) => {
    const k = fromLe(sha512(new Uint8Array([...rEncoding, ...pointBytes, ...bytes]))) % L;
    return new Uint8Array([...rEncoding, ...le32((k * scalar) % L)]);
  };
  const universal = new Uint8Array([...le32(1n), ...le32(0n)]);
  const check = (signer: string, h: unknown, sig: Uint8Array, valid: boolean) => ({
    signer,
    protected: h,
    signature: toBase64url(sig),
    valid,
  });

  const cases = [
    { name: "valid", ...check(did, header, signature, true) },
    { name: "role changed after signing", ...check(did, { ...header, role: "witness" }, signature, false) },
    { name: "signature of a different key", ...check(publicKeyToDid(ed25519.getPublicKey(SECOND_SEED)), header, signature, false) },
    { name: "non-canonical S (S + L)", ...check(did, header, new Uint8Array([...signature.slice(0, 32), ...le32(fromLe(signature.slice(32)) + L)]), false) },
    { name: "nonce r = 0, canonical R (valid under RFC 8032)", ...check(did, header, zeroNonce(le32(1n)), true) },
    { name: "nonce r = 0, non-canonical R (y = p + 1)", ...check(did, header, zeroNonce(le32(P + 1n)), false) },
    ...SMALL_ORDER_Y.flatMap((y) =>
      [0, 0x80].map((sign) => {
        const key = fromHex(y);
        key[31] = (key[31] ?? 0) | sign;
        return { name: `small-order public key y=${y.slice(0, 8)}… sign=${String(sign >> 7)}`, ...check(publicKeyToDid(key), header, universal, false) };
      }),
    ),
  ];
  for (const c of cases) {
    const result = await ed25519Suite().verify(c.signer, signedBytes(c.protected), fromBase64urlSafe(c.signature), PROFILE_ID);
    expect(result === "valid", c.name).toBe(c.valid);
  }
  return {
    description:
      "Ed25519 profile docseal-ed25519-v1. signedBytes = UTF8(\"DocSeal/v1/signature\\0\") || SHA-256(JCS(protected)). 'valid' is the required verification result. Small-order keys must be rejected even though some libraries accept them.",
    seed: toHex(SEED),
    publicKey: toHex(ed25519.getPublicKey(SEED)),
    did,
    example: {
      protected: header,
      jcs: new TextDecoder().decode(jcs(header)),
      protectedHash: toHex(jsonHash(header)),
      signedBytes: toHex(bytes),
      signature: toBase64url(signature),
    },
    smallOrderY: SMALL_ORDER_Y,
    cases,
  };
}

function fromBase64urlSafe(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

// ---------------------------------------------------------------------------
// Seal

async function sealVectors() {
  const first = await sealPackage({
    files: [{ path: "a.txt", data: utf8("a") }],
    signer: memoryKeyProvider(SEED),
    now: () => NOW,
    randomBytes: seeded("seal"),
  });
  const second: SignatureEnvelope = { ...first.envelope, protected: { ...first.envelope.protected, signer: publicKeyToDid(ed25519.getPublicKey(SECOND_SEED)), role: "witness" } };
  second.value = toBase64url(ed25519.sign(signedBytes(second.protected), SECOND_SEED));
  const envelopes = [second, first.envelope];
  const digests = envelopes.map(jsonHash);
  const statementHash = jsonHash(first.statement);
  const setHash = signaturesSetHash(digests);
  return {
    description:
      "Seal (FORMAT-v0.1 §Seal). envelopeDigest = SHA-256(JCS(envelope)); signaturesSetHash = SHA-256(\"DocSeal/v1/signature-set\\0\" || sorted digests); seal = SHA-256(\"DocSeal/v1/anchor\\0\" || statementHash || signaturesSetHash).",
    manifest: first.manifest,
    manifestHash: toHex(jsonHash(first.manifest)),
    statement: first.statement,
    statementHash: toHex(statementHash),
    envelopes,
    envelopeDigests: digests.map(toHex),
    signaturesSetHash: toHex(setHash),
    seal: toHex(sealDigest(statementHash, setHash)),
  };
}

// ---------------------------------------------------------------------------
// Golden packages

interface Expected {
  axes: AxisVerdicts;
  overall: OverallVerdict;
}

interface Golden {
  file: string;
  description: string;
  expected: Expected;
  build: () => Promise<Uint8Array>;
}

const OK: AxisVerdicts = {
  format: "valid",
  integrity: "valid",
  signature: "valid",
  trust: "not-evaluated",
  time: "missing",
  completeness: "full",
};
const FORMAT_FAILED: AxisVerdicts = {
  format: "invalid",
  integrity: "not-checked",
  signature: "missing",
  trust: "not-evaluated",
  time: "missing",
  completeness: "incomplete",
};

const pretty = (value: unknown) => utf8(`${JSON.stringify(value, null, 2)}\n`);
const json = (bytes: Uint8Array | undefined) => parseJson(bytes ?? new Uint8Array()) as Record<string, unknown>;

/** A pending OpenTimestamps receipt, as a calendar would return it before Bitcoin confirms. */
const pendingAnchor: AnchorProvider = {
  id: "opentimestamps",
  submit: (digest) =>
    Promise.resolve({
      provider: "opentimestamps",
      network: BITCOIN_MAINNET,
      digestAlgorithm: "sha-256",
      digest: toHex(digest),
      proof: toBase64url(
        serializeDetached({
          hashOp: "sha256",
          timestamp: { msg: digest, attestations: [{ kind: "pending", uri: "https://alice.btc.calendar.opentimestamps.org" }], ops: [] },
        }),
      ),
    }),
  verify: () => Promise.reject(new Error("not used")),
};

async function base(options: { anchor?: boolean; label?: string } = {}): Promise<Uint8Array> {
  const result = await sealPackage({
    files: [
      { path: "contract.pdf", data: utf8("%PDF-1.7 supply agreement 17/2026"), mediaType: "application/pdf" },
      { path: "annex/приложение 1.txt", data: utf8("Приложение 1: график поставки") },
      { path: "empty.txt", data: new Uint8Array() },
    ],
    signer: memoryKeyProvider(SEED),
    role: "author",
    metadata: { title: "Supply agreement 17/2026" },
    generator: "docseal-test-vectors",
    now: () => NOW,
    randomBytes: seeded(options.label ?? "golden"),
    ...(options.anchor ? { anchors: [pendingAnchor] } : {}),
  });
  return result.container;
}

async function mutate(change: (c: PackageContents) => void, options: { anchor?: boolean } = {}): Promise<Uint8Array> {
  const contents = await readContainer(await base(options));
  change(contents);
  return await writeContainer(contents);
}

/** Offset of the first local (0x04034b50) or central (0x02014b50) header for `name`. */
function headerOf(zip: Uint8Array, signature: number, name: string): number {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const nameOffset = signature === 0x04034b50 ? 30 : 46;
  const target = utf8(name);
  for (let pos = 0; pos < zip.length - 4; pos++) {
    if (view.getUint32(pos, true) === signature && target.every((byte, i) => zip[pos + nameOffset + i] === byte)) {
      return pos;
    }
  }
  throw new Error(`no header for ${name}`);
}

/** Replaces bytes in the archive in place (same length), to build what zip writers refuse to. */
function patch(zip: Uint8Array, from: string, to: string): Uint8Array {
  const out = zip.slice();
  const needle = utf8(from);
  for (let i = 0; i <= out.length - needle.length; i++) {
    if (needle.every((byte, j) => out[i + j] === byte)) out.set(utf8(to), i);
  }
  return out;
}

const GOLDEN: Golden[] = [
  {
    file: "valid-basic.dseal",
    description: "Three files (nested Unicode path, empty file), one signature, no anchor.",
    expected: { axes: OK, overall: "indeterminate" },
    build: () => base(),
  },
  {
    file: "valid-single-file.dseal",
    description: "One file, the smallest possible package.",
    expected: { axes: OK, overall: "indeterminate" },
    build: async () =>
      (await sealPackage({ files: [{ path: "a.txt", data: utf8("a") }], signer: memoryKeyProvider(SEED), now: () => NOW, randomBytes: seeded("single") })).container,
  },
  {
    file: "valid-pending-anchor.dseal",
    description: "Pending OpenTimestamps anchor bound to the package. Offline, the anchor cannot be confirmed: time is unsupported.",
    expected: { axes: { ...OK, time: "unsupported", completeness: "incomplete" }, overall: "indeterminate" },
    build: () => base({ anchor: true }),
  },
  {
    file: "tampered-content.dseal",
    description: "One byte of contract.pdf changed after sealing.",
    expected: { axes: { ...OK, integrity: "invalid" }, overall: "invalid" },
    build: () => mutate((c) => c.files.set("contract.pdf", utf8("%PDF-1.7 supply agreement 18/2026"))),
  },
  {
    file: "forged-manifest.dseal",
    description: "contract.pdf replaced and its manifest entry recomputed; the statement still names the old manifest.",
    expected: { axes: { ...OK, integrity: "invalid" }, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const forged = utf8("%PDF-1.7 forged");
        c.files.set("contract.pdf", forged);
        const manifest = json(c.manifest) as { files: { path: string; size: number; hash: string }[] };
        const entry = manifest.files.find((f) => f.path === "contract.pdf");
        if (entry) Object.assign(entry, { size: forged.length, hash: toHex(hash(forged)) });
        c.manifest = pretty(manifest);
      }),
  },
  {
    file: "forged-statement.dseal",
    description: "Manifest title changed and statement.manifestHash recomputed; the signature no longer covers the statement.",
    expected: { axes: { ...OK, signature: "invalid" }, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const manifest = json(c.manifest) as { metadata: Record<string, unknown> };
        manifest.metadata.title = "Forged title";
        c.manifest = pretty(manifest);
        const statement = json(c.statement);
        statement.manifestHash = toHex(jsonHash(manifest));
        c.statement = pretty(statement);
      }),
  },
  {
    file: "extra-file.dseal",
    description: "A file not listed in the manifest was added.",
    expected: { axes: { ...OK, integrity: "invalid" }, overall: "invalid" },
    build: () => mutate((c) => c.files.set("readme.txt", utf8("not signed"))),
  },
  {
    file: "missing-file.dseal",
    description: "A listed file was removed.",
    expected: { axes: { ...OK, integrity: "invalid", completeness: "incomplete" }, overall: "invalid" },
    build: () => mutate((c) => c.files.delete("empty.txt")),
  },
  {
    file: "renamed-file.dseal",
    description: "contract.pdf renamed in both the container and the manifest; the leaf includes the path.",
    expected: { axes: { ...OK, integrity: "invalid" }, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const data = c.files.get("contract.pdf") ?? new Uint8Array();
        c.files.delete("contract.pdf");
        c.files.set("contract-v2.pdf", data);
        const manifest = json(c.manifest) as { files: { path: string }[] };
        for (const f of manifest.files) if (f.path === "contract.pdf") f.path = "contract-v2.pdf";
        manifest.files.sort((a, b) => comparePaths(a.path, b.path));
        c.manifest = pretty(manifest);
      }),
  },
  {
    file: "signed-field-changed.dseal",
    description: "The signer role was edited inside the protected header.",
    expected: { axes: { ...OK, signature: "invalid" }, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const envelope = json(c.signatures.get("signatures/0001.json")) as { protected: Record<string, unknown> };
        envelope.protected.role = "witness";
        c.signatures.set("signatures/0001.json", pretty(envelope));
      }),
  },
  {
    file: "duplicate-envelope.dseal",
    description: "The same signature envelope included twice.",
    expected: { axes: { ...OK, signature: "invalid" }, overall: "invalid" },
    build: () => mutate((c) => c.signatures.set("signatures/0002.json", c.signatures.get("signatures/0001.json") ?? new Uint8Array())),
  },
  {
    file: "unknown-suite.dseal",
    description: "The signature names a suite this verifier does not implement.",
    expected: { axes: { ...OK, signature: "unsupported", completeness: "incomplete" }, overall: "indeterminate" },
    build: () =>
      mutate((c) => {
        const envelope = json(c.signatures.get("signatures/0001.json")) as { protected: Record<string, unknown> };
        envelope.protected.suite = "gost-2012-256";
        c.signatures.set("signatures/0001.json", pretty(envelope));
      }),
  },
  {
    file: "critical-signature-extension.dseal",
    description: "The protected header lists an unknown critical extension.",
    expected: { axes: { ...OK, signature: "unsupported", completeness: "incomplete" }, overall: "indeterminate" },
    build: () =>
      mutate((c) => {
        const envelope = json(c.signatures.get("signatures/0001.json")) as { protected: Record<string, unknown> };
        envelope.protected.critical = ["x-future"];
        c.signatures.set("signatures/0001.json", pretty(envelope));
      }),
  },
  {
    file: "critical-statement-extension.dseal",
    description: "The statement lists an unknown critical extension.",
    expected: { axes: { ...FORMAT_FAILED, format: "unsupported" }, overall: "indeterminate" },
    build: () =>
      mutate((c) => {
        const statement = json(c.statement);
        statement.critical = ["x-future"];
        c.statement = pretty(statement);
      }),
  },
  {
    file: "future-version.dseal",
    description: "statement.version is 2.",
    expected: { axes: { ...FORMAT_FAILED, format: "unsupported" }, overall: "indeterminate" },
    build: () =>
      mutate((c) => {
        const statement = json(c.statement);
        statement.version = 2;
        c.statement = pretty(statement);
      }),
  },
  {
    file: "json-duplicate-key.dseal",
    description: "manifest.json repeats a key. JSON.parse and Python's json module accept this silently; DocSeal must not.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const text = new TextDecoder().decode(c.manifest).trimEnd();
        c.manifest = utf8(`${text.slice(0, -1)},\n  "generator": "evil"\n}\n`);
      }),
  },
  {
    file: "path-not-nfc.dseal",
    description: "A file stored under a non-NFC (decomposed) path.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: () => mutate((c) => c.files.set("café.txt", utf8("x"))),
  },
  {
    file: "case-collision.dseal",
    description: "Two files whose paths differ only in case.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: () => mutate((c) => c.files.set("CONTRACT.PDF", utf8("x"))),
  },
  {
    file: "path-traversal.dseal",
    description: "A container entry named files/../evil.sh.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const zip = await mutate((c) => c.files.set("xx/evil.sh", utf8("#!/bin/sh")));
      return patch(zip, "files/xx/evil.sh", "files/../evil.sh");
    },
  },
  {
    file: "duplicate-entry.dseal",
    description: "Two container entries with the same name.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => patch(await mutate((c) => c.files.set("empty.tx_", utf8("other"))), "files/empty.tx_", "files/empty.txt"),
  },
  {
    file: "symlink-entry.dseal",
    description: "A container entry marked as a Unix symbolic link.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const c = await readContainer(await base());
      return zipSync({
        mimetype: [utf8("application/vnd.docseal+zip"), { level: 0 }],
        "manifest.json": c.manifest,
        "statement.json": c.statement,
        ...Object.fromEntries([...c.files].map(([path, data]) => [`files/${path}`, data])),
        "files/link": [utf8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
        ...Object.fromEntries(c.signatures),
      }, { mtime: new Date(1980, 0, 1) });
    },
  },
  {
    file: "compressed-mimetype.dseal",
    description: "mimetype is the first entry but compressed.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const c = await readContainer(await base());
      return zipSync({
        mimetype: [utf8("application/vnd.docseal+zip"), { level: 9 }],
        "manifest.json": c.manifest,
        "statement.json": c.statement,
        ...Object.fromEntries([...c.files].map(([path, data]) => [`files/${path}`, data])),
        ...Object.fromEntries(c.signatures),
      }, { mtime: new Date(1980, 0, 1) });
    },
  },
  {
    file: "unexpected-entry.dseal",
    description: "An entry outside the defined layout (META-INF/).",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const c = await readContainer(await base());
      return zipSync({
        mimetype: [utf8("application/vnd.docseal+zip"), { level: 0 }],
        "manifest.json": c.manifest,
        "statement.json": c.statement,
        ...Object.fromEntries([...c.files].map(([path, data]) => [`files/${path}`, data])),
        ...Object.fromEntries(c.signatures),
        "META-INF/manifest.xml": utf8("<x/>"),
      }, { mtime: new Date(1980, 0, 1) });
    },
  },
  {
    file: "impossible-date.dseal",
    description: "statement.createdAt is 2026-02-30, which matches the pattern but is not a date.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const statement = json(c.statement);
        statement.createdAt = "2026-02-30T12:00:00Z";
        c.statement = pretty(statement);
      }),
  },
  {
    file: "huge-number.dseal",
    description: "manifest metadata holds a 400-digit integer, beyond the range of a double.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const text = new TextDecoder().decode(c.manifest);
        c.manifest = utf8(text.replace('"title"', `"huge": 1${"0".repeat(400)}, "title"`));
      }),
  },
  {
    file: "local-header-mismatch.dseal",
    description: "The local header of files/contract.pdf declares a different CRC than the central directory.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const zip = await base();
      const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
      view.setUint32(headerOf(zip, 0x04034b50, "files/contract.pdf") + 14, 0x12345678, true);
      return zip;
    },
  },
  {
    file: "crc-mismatch.dseal",
    description: "Both headers of files/contract.pdf carry the same wrong CRC-32.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const zip = await base();
      const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
      const local = headerOf(zip, 0x04034b50, "files/contract.pdf");
      const forged = view.getUint32(local + 14, true) ^ 1;
      view.setUint32(local + 14, forged, true);
      view.setUint32(headerOf(zip, 0x02014b50, "files/contract.pdf") + 16, forged, true);
      return zip;
    },
  },
  {
    file: "gap-before-directory.dseal",
    description: "Unreferenced bytes (a hidden extra entry) between the last entry and the central directory.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const zip = await base();
      const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
      const end = zip.length - 22;
      const directoryOffset = view.getUint32(end + 16, true);
      const hidden = utf8("PK\u0003\u0004 hidden entry that streaming unzip tools would see");
      const out = new Uint8Array(zip.length + hidden.length);
      out.set(zip.subarray(0, directoryOffset));
      out.set(hidden, directoryOffset);
      out.set(zip.subarray(directoryOffset), directoryOffset + hidden.length);
      new DataView(out.buffer).setUint32(end + hidden.length + 16, directoryOffset + hidden.length, true);
      return out;
    },
  },
  {
    file: "valid-zip64.dseal",
    description: "valid-basic with ZIP64 fields everywhere: every entry's sizes and offset, and the end of central directory.",
    expected: { axes: OK, overall: "indeterminate" },
    build: async () => writeContainer(await readContainer(await base()), { forceZip64: true }),
  },
  {
    file: "zip64-end-mismatch.dseal",
    description: "ZIP64 archive whose classic end record gives an entry count that is neither the marker nor the ZIP64 count.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const zip = await writeContainer(await readContainer(await base()), { forceZip64: true });
      new DataView(zip.buffer, zip.byteOffset, zip.byteLength).setUint16(zip.length - 22 + 10, 3, true);
      return zip;
    },
  },
  {
    file: "unicode-path-extra.dseal",
    description: "files/contract.pdf carries an Info-ZIP Unicode Path extra field naming another file, which some tools extract under.",
    expected: { axes: FORMAT_FAILED, overall: "invalid" },
    build: async () => {
      const c = await readContainer(await base());
      const name = utf8("files/other.pdf");
      const unicodePath = new Uint8Array(5 + name.length);
      unicodePath[0] = 1;
      new DataView(unicodePath.buffer).setUint32(1, crc32(utf8("files/contract.pdf")), true);
      unicodePath.set(name, 5);
      return zipSync({
        mimetype: [utf8("application/vnd.docseal+zip"), { level: 0 }],
        "manifest.json": c.manifest,
        "statement.json": c.statement,
        ...Object.fromEntries([...c.files].map(([path, data]) => [`files/${path}`, path === "contract.pdf" ? [data, { extra: { 0x7075: unicodePath } }] : data])),
        ...Object.fromEntries(c.signatures),
      }, { mtime: new Date(1980, 0, 1) });
    },
  },
  {
    file: "long-signer.dseal",
    description: "protected.signer is a did:key with 100000 base58 digits. Must be rejected quickly, not decoded.",
    expected: { axes: { ...OK, signature: "invalid" }, overall: "invalid" },
    build: () =>
      mutate((c) => {
        const envelope = json(c.signatures.get("signatures/0001.json")) as { protected: Record<string, unknown> };
        envelope.protected.signer = `did:key:z${"2".repeat(100_000)}`;
        c.signatures.set("signatures/0001.json", pretty(envelope));
      }),
  },
  {
    file: "anchor-from-other-package.dseal",
    description: "The anchor file of a different package was copied in.",
    expected: { axes: { ...OK, time: "invalid" }, overall: "invalid" },
    build: async () => {
      const other = await readContainer(await base({ anchor: true, label: "other package" }));
      return mutate((c) => c.anchors.set("anchors/seal-1.json", other.anchors.get("anchors/seal-1.json") ?? new Uint8Array()), { anchor: true });
    },
  },
  {
    file: "anchor-seal-edited.dseal",
    description: "anchor.seal and every receipt digest replaced consistently with a value that is not this package's seal.",
    expected: { axes: { ...OK, time: "invalid" }, overall: "invalid" },
    build: () =>
      mutate(
        (c) => {
          const anchor = json(c.anchors.get("anchors/seal-1.json")) as { seal: string; receipts: { digest: string }[] };
          anchor.seal = "11".repeat(32);
          for (const r of anchor.receipts) r.digest = anchor.seal;
          c.anchors.set("anchors/seal-1.json", pretty(anchor));
        },
        { anchor: true },
      ),
  },
];

/** The configuration every verifier uses for golden packages: offline, no trust policy. */
async function verifyOffline(zip: Uint8Array) {
  return verifyPackage(zip, { suites: [ed25519Suite()], anchors: [openTimestamps()] });
}

// ---------------------------------------------------------------------------

describe("test vectors", () => {
  it("jcs.json", () => {
    writeOrCompare("jcs.json", jcsVectors());
  });

  it("paths.json", () => {
    writeOrCompare("paths.json", pathVectors());
  });

  it("merkle.json", () => {
    writeOrCompare("merkle.json", merkleVectors());
  });

  it("signature.json", async () => {
    writeOrCompare("signature.json", await signatureVectors());
  });

  it("small-order list matches noble's isSmallOrder", () => {
    for (const y of SMALL_ORDER_Y) {
      for (const sign of [0, 0x80]) {
        const encoding = fromHex(y);
        encoding[31] = (encoding[31] ?? 0) | sign;
        try {
          expect(ed25519.Point.fromBytes(encoding, true).isSmallOrder(), y).toBe(true);
        } catch {
          // Not a valid encoding with this sign bit (e.g. x = 0 with the sign set): rejected anyway.
        }
      }
    }
  });

  it("seal.json", async () => {
    writeOrCompare("seal.json", await sealVectors());
  });

  it("golden packages verify as expected", async () => {
    const index = [];
    for (const golden of GOLDEN) {
      const file = new URL(`packages/${golden.file}`, VECTORS);
      if (UPDATE || (ADD_MISSING && !existsSync(file))) {
        mkdirSync(new URL("packages/", VECTORS), { recursive: true });
        writeFileSync(file, await golden.build());
      }
      const report = await verifyOffline(new Uint8Array(readFileSync(file)));
      expect({ axes: report.axes, overall: report.overall }, golden.file).toEqual(golden.expected);
      index.push({ file: golden.file, description: golden.description, expected: golden.expected });
    }
    writeOrCompare("packages/expected.json", {
      description:
        "Golden packages. Verify each offline with no trust policy and only the ed25519 suite and the opentimestamps provider registered; the result must equal 'expected'. Without a chain source a bound anchor is 'unsupported'; an unbound one is 'invalid'.",
      packages: index,
    });
  });

  it("documents in the golden packages conform to the JSON Schemas", async () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const schema = (name: string) => ajv.compile(JSON.parse(readFileSync(new URL(name, SCHEMAS), "utf8")) as object);
    const validators = {
      manifest: schema("manifest.schema.json"),
      statement: schema("statement.schema.json"),
      signature: schema("signature.schema.json"),
      anchor: schema("anchor.schema.json"),
    };
    for (const file of ["valid-basic.dseal", "valid-single-file.dseal", "valid-pending-anchor.dseal"]) {
      const c = await readContainer(new Uint8Array(readFileSync(new URL(`packages/${file}`, VECTORS))));
      expect(validators.manifest(json(c.manifest)), JSON.stringify(validators.manifest.errors)).toBe(true);
      expect(validators.statement(json(c.statement)), JSON.stringify(validators.statement.errors)).toBe(true);
      for (const bytes of c.signatures.values()) {
        expect(validators.signature(json(bytes)), JSON.stringify(validators.signature.errors)).toBe(true);
      }
      for (const bytes of c.anchors.values()) {
        expect(validators.anchor(json(bytes)), JSON.stringify(validators.anchor.errors)).toBe(true);
      }
    }
    // A schema that accepts everything would pass the loop above.
    expect(validators.statement({ type: "docseal-package-statement" })).toBe(false);
    expect(validators.manifest({ ...json((await readContainer(new Uint8Array(readFileSync(new URL("packages/valid-basic.dseal", VECTORS))))).manifest), files: [] })).toBe(false);
  });
});
