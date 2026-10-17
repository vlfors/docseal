/**
 * Differential fuzzing: the TypeScript verifier and the independent Python verifier must reach
 * the same verdicts on every mutated package. A disagreement is a bug in one of them or a gap
 * in the specification. Skipped when the Python environment is missing.
 *
 *   FUZZ_RUNS=5000 FUZZ_SEED=42 pnpm vitest run tests/differential.test.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPackage } from "@docseal/core";
import { openTimestamps } from "@docseal/anchor-ots";
import { ed25519Suite } from "@docseal/sig-ed25519";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mutatedPackage } from "./mutations.js";

const PYTHON = new URL("../verifiers/python/.venv/bin/python", import.meta.url).pathname;
const VERIFIER = new URL("../verifiers/python/docseal_verify.py", import.meta.url).pathname;
const runs = Number(process.env.FUZZ_RUNS ?? 300);
// fast-check seeds are 32-bit; a CI run id is folded into range.
const seed = Number(process.env.FUZZ_SEED ?? Date.now()) % 2_147_483_647;

describe.skipIf(!existsSync(PYTHON))("TypeScript and Python verifiers", () => {
  it(`agree on ${String(runs)} mutated packages (seed ${String(seed)})`, { timeout: Math.max(60_000, runs * 200) }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "docseal-diff-"));
    try {
      const cases = fc.sample(mutatedPackage, { numRuns: runs, seed });
      const typescript = new Map<string, { axes: unknown; overall: string }>();
      const described = new Map<string, string>();
      for (const [i, mutated] of cases.entries()) {
        const name = `${String(i).padStart(5, "0")}.dseal`;
        const zip = await mutated.bytes();
        writeFileSync(join(dir, name), zip);
        const report = await verifyPackage(zip, { suites: [ed25519Suite()], anchors: [openTimestamps()] });
        typescript.set(name, { axes: report.axes, overall: report.overall });
        described.set(name, `${mutated.seed}: ${mutated.mutations.join("; ")}`);
      }
      const python = JSON.parse(execFileSync(PYTHON, ["-I", VERIFIER, "batch", dir], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as Record<string, unknown>;

      const disagreements = [...typescript].filter(([name, ts]) => JSON.stringify(python[name]) !== JSON.stringify(ts));
      if (disagreements.length > 0 && process.env.FUZZ_KEEP) {
        console.log(`Packages kept in ${dir}`);
      }
      expect(
        disagreements.slice(0, 5).map(([name, ts]) => ({ name, mutations: described.get(name), typescript: ts, python: python[name] })),
        `seed ${String(seed)}: ${String(disagreements.length)} of ${String(runs)} disagree`,
      ).toEqual([]);
    } finally {
      if (!process.env.FUZZ_KEEP) rmSync(dir, { recursive: true, force: true });
    }
  });
});
