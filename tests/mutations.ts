/**
 * Mutations of valid packages for fuzzing. Byte-level mutations mostly exercise the ZIP parser
 * (and stop at the CRC check); structural ones aim at header fields; semantic ones edit JSON
 * documents and files and repack, so the result is a well-formed ZIP that reaches the
 * verification logic.
 */
import { readFileSync } from "node:fs";
import { parseJson, readContainer, utf8, writeContainer, type PackageContents } from "@docseal/core";
import fc from "fast-check";

const VECTORS = new URL("../spec/vectors/packages/", import.meta.url);

/** Golden packages that are well formed: good starting points for mutations. */
export const SEEDS = ["valid-basic", "valid-single-file", "valid-pending-anchor", "valid-two-signers-pending-anchor", "valid-zip64", "extra-file", "missing-file", "unknown-suite"].map(
  (name) => ({ name, bytes: new Uint8Array(readFileSync(new URL(`${name}.dseal`, VECTORS))) }),
);

export type Mutation = { describe: string } & ({ kind: "bytes"; apply: (zip: Uint8Array) => Uint8Array } | { kind: "contents"; apply: (c: PackageContents) => void });

const interesting16 = [0, 1, 0x7fff, 0x8000, 0xfffe, 0xffff];
const interesting32 = [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
const HEADER_SIGNATURES = [0x04034b50, 0x02014b50, 0x06054b50, 0x06064b50, 0x07064b50];

function headerOffsets(zip: Uint8Array): number[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const offsets: number[] = [];
  for (let pos = 0; pos + 4 <= zip.length; pos++) {
    if (HEADER_SIGNATURES.includes(view.getUint32(pos, true))) offsets.push(pos);
  }
  return offsets;
}

const byteMutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })).map(([at, xor]): Mutation => ({
    kind: "bytes",
    describe: `xor byte ${String(at)} with ${String(xor)}`,
    apply: (zip) => {
      const out = zip.slice();
      const i = at % out.length;
      out[i] = (out[i] ?? 0) ^ xor;
      return out;
    },
  })),
  fc.tuple(fc.nat(), fc.uint8Array({ minLength: 1, maxLength: 16 })).map(([at, bytes]): Mutation => ({
    kind: "bytes",
    describe: `insert ${String(bytes.length)} bytes at ${String(at)}`,
    apply: (zip) => {
      const i = at % (zip.length + 1);
      return new Uint8Array([...zip.subarray(0, i), ...bytes, ...zip.subarray(i)]);
    },
  })),
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 64 })).map(([at, length]): Mutation => ({
    kind: "bytes",
    describe: `delete ${String(length)} bytes at ${String(at)}`,
    apply: (zip) => {
      const i = at % zip.length;
      return new Uint8Array([...zip.subarray(0, i), ...zip.subarray(i + length)]);
    },
  })),
  fc.nat().map((at): Mutation => ({ kind: "bytes", describe: `truncate at ${String(at)}`, apply: (zip) => zip.slice(0, at % zip.length) })),
  // A ZIP header field set to a boundary value: sizes, offsets, counts, lengths, flags.
  fc.tuple(fc.nat(), fc.integer({ min: 4, max: 54 }), fc.boolean(), fc.nat(), fc.integer({ min: -1, max: 1 })).map(
    ([pick, field, wide, value, delta]): Mutation => ({
      kind: "bytes",
      describe: `header field +${String(field)} (${String(wide ? 32 : 16)}-bit) ← ${delta === 0 ? "boundary" : "±1"}`,
      apply: (zip) => {
        const offsets = headerOffsets(zip);
        const out = zip.slice();
        const view = new DataView(out.buffer);
        const pos = (offsets[pick % Math.max(offsets.length, 1)] ?? 0) + field;
        if (pos + (wide ? 4 : 2) > out.length) return out;
        if (wide) {
          const current = view.getUint32(pos, true);
          view.setUint32(pos, delta === 0 ? (interesting32[value % interesting32.length] ?? 0) : (current + delta) >>> 0, true);
        } else {
          const current = view.getUint16(pos, true);
          view.setUint16(pos, delta === 0 ? (interesting16[value % interesting16.length] ?? 0) : (current + delta) & 0xffff, true);
        }
        return out;
      },
    }),
  ),
);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Every container (object or array) in a JSON value, with a way to edit it. */
function containers(value: Json): (Json[] | { [key: string]: Json })[] {
  const found: (Json[] | { [key: string]: Json })[] = [];
  const walk = (v: Json) => {
    if (v !== null && typeof v === "object") {
      found.push(v);
      for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child);
    }
  };
  walk(value);
  return found;
}

/** Values that are close to what the format expects, so edits get past the first check. */
const plausible: fc.Arbitrary<Json> = fc.oneof(
  fc.jsonValue() as fc.Arbitrary<Json>,
  fc.constantFrom<Json>(
    "", "00".repeat(32), "ff".repeat(32), "00".repeat(16), "sha-256", "docseal-v1", "any-valid", "ed25519", "docseal-ed25519-v1",
    "2026-02-29T00:00:00Z", "2024-02-29T23:59:59Z", "2026-10-16T12:00:00.5Z", "urn:uuid:00000000-0000-4000-8000-000000000000",
    "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp", "opentimestamps", "bip122:000000000019d6689c085ae165831e93",
    "a.txt", "contract.pdf", "Contract.pdf", "annex", "x/../y", "AAAA", 0, 1, -1, 2 ** 53, 2 ** 53 - 1, 0.5, 1e300, null, true, [], {},
  ),
);

const semanticMutation: fc.Arbitrary<Mutation> = fc.oneof(
  // Edit one JSON document: replace, delete, or add a member somewhere inside it.
  fc.tuple(fc.nat(), fc.nat(), fc.constantFrom("replace", "delete", "add"), fc.nat(), fc.string({ maxLength: 12 }), plausible).map(
    ([document, node, op, member, key, value]): Mutation => ({
      kind: "contents",
      describe: `${op} in JSON document ${String(document)}, node ${String(node)}, member ${String(member)}`,
      apply: (c) => {
        const names = ["manifest", "statement", ...c.signatures.keys(), ...c.anchors.keys()];
        const name = names[document % names.length] ?? "manifest";
        const bytes = name === "manifest" ? c.manifest : name === "statement" ? c.statement : (c.signatures.get(name) ?? c.anchors.get(name));
        let root: Json;
        try {
          root = parseJson(bytes ?? new Uint8Array()) as Json;
        } catch {
          return;
        }
        const targets = containers(root);
        const target = targets[node % Math.max(targets.length, 1)];
        if (target) {
          if (Array.isArray(target)) {
            const i = member % (target.length + 1);
            if (op === "delete") target.splice(i, 1);
            else if (op === "add") target.splice(i, 0, value);
            else target[i] = value;
          } else {
            const keys = Object.keys(target);
            const existing = keys[member % Math.max(keys.length, 1)];
            if (op === "delete" && existing !== undefined) Reflect.deleteProperty(target, existing);
            else if (op === "add") target[key] = value;
            else if (existing !== undefined) target[existing] = value;
          }
        }
        const out = utf8(JSON.stringify(root, null, 2));
        if (name === "manifest") c.manifest = out;
        else if (name === "statement") c.statement = out;
        else if (c.signatures.has(name)) c.signatures.set(name, out);
        else c.anchors.set(name, out);
      },
    }),
  ),
  // Change, add, remove, or rename a document.
  fc.tuple(fc.constantFrom("edit", "add", "remove", "rename", "empty"), fc.nat(), fc.uint8Array({ maxLength: 40 }), fc.constantFrom("new.txt", "A.TXT", "contract.PDF", "annex/x", "z")).map(
    ([op, pick, data, newPath]): Mutation => ({
      kind: "contents",
      describe: `${op} a document (${newPath})`,
      apply: (c) => {
        const paths = [...c.files.keys()];
        const path = paths[pick % paths.length] ?? "a";
        const current = c.files.get(path) ?? new Uint8Array();
        if (op === "edit") c.files.set(path, current.length > 0 ? current.map((b, i) => (i === pick % current.length ? b ^ 1 : b)) : data);
        else if (op === "add") c.files.set(newPath, data);
        else if (op === "remove") c.files.delete(path);
        else if (op === "empty") c.files.set(path, new Uint8Array());
        else {
          c.files.delete(path);
          c.files.set(newPath, current);
        }
      },
    }),
  ),
  // Drop, duplicate, or rename signature and anchor entries.
  fc.tuple(fc.constantFrom("drop-signature", "duplicate-signature", "drop-anchor", "copy-anchor", "rename-signature"), fc.nat()).map(
    ([op]): Mutation => ({
      kind: "contents",
      describe: op,
      apply: (c) => {
        const [firstSignature] = c.signatures;
        const [firstAnchor] = c.anchors;
        if (op === "drop-signature" && firstSignature) c.signatures.delete(firstSignature[0]);
        if (op === "duplicate-signature" && firstSignature) c.signatures.set("signatures/0002.json", firstSignature[1]);
        if (op === "rename-signature" && firstSignature) {
          c.signatures.delete(firstSignature[0]);
          c.signatures.set("signatures/00001.json", firstSignature[1]);
        }
        if (op === "drop-anchor" && firstAnchor) c.anchors.delete(firstAnchor[0]);
        if (op === "copy-anchor" && firstAnchor) c.anchors.set("anchors/seal-2.json", firstAnchor[1]);
      },
    }),
  ),
);

export const mutatedPackage: fc.Arbitrary<{ seed: string; mutations: string[]; bytes: () => Promise<Uint8Array> }> = fc
  .tuple(fc.nat(), fc.array(fc.oneof({ weight: 2, arbitrary: semanticMutation }, { weight: 1, arbitrary: byteMutation }), { minLength: 1, maxLength: 3 }))
  .map(([seedIndex, mutations]) => {
    const seed = SEEDS[seedIndex % SEEDS.length] ?? SEEDS[0];
    if (!seed) throw new Error("no seeds");
    return {
      seed: seed.name,
      mutations: mutations.map((m) => m.describe),
      bytes: async () => {
        let zip = seed.bytes;
        for (const mutation of mutations) {
          if (mutation.kind === "bytes") {
            zip = mutation.apply(zip);
          } else {
            let contents: PackageContents;
            try {
              contents = await readContainer(zip);
            } catch {
              continue; // an earlier byte mutation broke the container; nothing to edit
            }
            mutation.apply(contents);
            zip = await writeContainer(contents);
          }
        }
        return zip;
      },
    };
  });
