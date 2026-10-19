/**
 * Verifies a package the way a recipient would, with the CLI and with the independent Python
 * verifier, and returns their verdicts on each axis.
 */
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { VerificationReport } from "@docseal/core";
import type { Io } from "../../apps/cli/src/io";
import { main } from "../../apps/cli/src/main";

export const PASSPHRASE = "correct horse battery";

const PYTHON = fileURLToPath(new URL("../../verifiers/python/.venv/bin/python", import.meta.url));
const VERIFIER = fileURLToPath(new URL("../../verifiers/python/docseal_verify.py", import.meta.url));

/** Runs the CLI in-process, with PASSPHRASE in its environment. */
export async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = "";
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => undefined,
    env: { DOCSEAL_PASSPHRASE: PASSPHRASE },
    readSecret: () => Promise.reject(new Error("no terminal in tests")),
  };
  return { code: await main(args, io), stdout };
}

export async function verifyWithCli(path: string, trustedKeys: string): Promise<VerificationReport["axes"]> {
  const result = await cli(["verify", path, "--trust", trustedKeys, "--offline", "--json"]);
  return (JSON.parse(result.stdout) as VerificationReport).axes;
}

/** Whether the Python verifier and its dependencies run here (CI creates the virtualenv). */
export const hasPython = (() => {
  try {
    execFileSync(PYTHON, ["-I", VERIFIER, "--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

export async function verifyWithPython(path: string, trustedKeys: string): Promise<VerificationReport["axes"]> {
  const run = promisify(execFile);
  // A verdict other than valid is a non-zero exit code; the report is on stdout either way.
  const result = await run(PYTHON, ["-I", VERIFIER, "verify", path, "--trust", trustedKeys, "--json"]).catch((error: unknown) => {
    const failed = error as { stdout?: string; stderr?: string };
    if (!failed.stdout) {
      throw new Error(`The Python verifier failed: ${failed.stderr ?? String(error)}`);
    }
    return { stdout: failed.stdout };
  });
  return (JSON.parse(result.stdout) as VerificationReport).axes;
}
