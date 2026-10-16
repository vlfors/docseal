import { describe, expect, it } from "vitest";
import { hash, utf8 } from "./bytes.js";
import { toHex } from "./encoding.js";
import { leafHash, merkleRoot, nodeHash } from "./merkle.js";

const leaves = (n: number) => Array.from({ length: n }, (_, i) => hash(Uint8Array.of(i)));

/** Independent formulation from FORMAT-v0.1: pair level by level, promote an unpaired node. */
function levelByLevel(level: Uint8Array[]): Uint8Array {
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];
      if (left === undefined) {
        throw new Error("unreachable");
      }
      next.push(right === undefined ? left : nodeHash(left, right));
    }
    level = next;
  }
  const [root] = level;
  if (root === undefined) {
    throw new Error("empty");
  }
  return root;
}

describe("merkleRoot", () => {
  it("is the leaf itself for one leaf", () => {
    const [a] = leaves(1) as [Uint8Array];
    expect(merkleRoot([a])).toEqual(a);
  });

  it("matches hand-built trees", () => {
    const [a, b, c, d, e] = leaves(5) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    const ab = nodeHash(a, b);
    const cd = nodeHash(c, d);
    expect(merkleRoot([a, b])).toEqual(ab);
    expect(merkleRoot([a, b, c])).toEqual(nodeHash(ab, c));
    expect(merkleRoot([a, b, c, d])).toEqual(nodeHash(ab, cd));
    expect(merkleRoot([a, b, c, d, e])).toEqual(nodeHash(nodeHash(ab, cd), e));
  });

  it("equals the level-by-level construction for 1..100 leaves", () => {
    for (let n = 1; n <= 100; n++) {
      expect(toHex(merkleRoot(leaves(n)))).toBe(toHex(levelByLevel(leaves(n))));
    }
  });

  it("depends on leaf order", () => {
    const [a, b] = leaves(2) as [Uint8Array, Uint8Array];
    expect(merkleRoot([a, b])).not.toEqual(merkleRoot([b, a]));
  });

  it("rejects an empty tree", () => {
    expect(() => merkleRoot([])).toThrow(RangeError);
  });
});

describe("leafHash", () => {
  const entry = { path: "a.txt", size: 3, hash: "00".repeat(32), salt: "11".repeat(16) };

  it("is H(0x00 || JCS(path, size, hash, salt))", () => {
    const json = `{"hash":"${entry.hash}","path":"a.txt","salt":"${entry.salt}","size":3}`;
    expect(leafHash(entry)).toEqual(hash(Uint8Array.of(0), utf8(json)));
  });

  it("ignores fields outside the leaf", () => {
    expect(leafHash({ ...entry, mediaType: "text/plain" } as typeof entry)).toEqual(leafHash(entry));
  });

  it.each([{ path: "b.txt" }, { size: 4 }, { hash: "01".repeat(32) }, { salt: "12".repeat(16) }])(
    "changes when %j changes",
    (change) => {
      expect(leafHash({ ...entry, ...change })).not.toEqual(leafHash(entry));
    },
  );

  it("cannot be confused with a node", () => {
    const [a, b] = leaves(2) as [Uint8Array, Uint8Array];
    const forgedLeaf = hash(Uint8Array.of(0), a, b);
    expect(forgedLeaf).not.toEqual(nodeHash(a, b));
  });
});
