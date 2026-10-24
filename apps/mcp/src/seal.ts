import { checkPathCollisions, validatePath, toHex, utf8, hash, type SealFile } from "@docseal/core";
import { OutputExistsError, PASSPHRASE_ENV, UserError, collectFiles, createDocSeal, openKey, withOutput } from "@docseal/node";
import { memoryKeyProvider } from "@docseal/sig-ed25519";
import type { Fetch } from "@docseal/anchor-ots";
import { lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as z from "zod";
import { resolveInRoots } from "./paths.js";
import type { SealInput, SealOutput } from "./schemas.js";
import { MAX_ITEMS, fence } from "./untrusted.js";

/** Names shown in the confirmation; the rest are counted. */
const SHOWN_NAMES = 20;

export const confirmation = z.object({
  confirm: z.boolean().describe("Sign these files with your key"),
});

export interface Plan {
  files: SealFile[];
  /** The real path the package will be written to. */
  output: string;
  /** Digest of everything the person is asked to confirm. */
  intent: string;
  /** The confirmation shown to the person. */
  message: string;
}

/**
 * Works out what a seal call would do, without opening the key or writing anything: the
 * files (pinned, as `docseal seal` pins them), where the package goes, and the confirmation
 * the person sees. Called again after the person answers, so the seal uses what they saw:
 * the intent must match.
 */
export async function planSeal(input: SealInput, roots: readonly string[], signer: string): Promise<Plan> {
  if (input.paths.length === 0) throw new UserError("Nothing to seal: no paths given");
  const reals = await Promise.all(input.paths.map((path) => resolveInRoots(path, roots)));
  const files = await collectFiles(reals);
  if (files.length > 10_000) throw new UserError(`Too many files to seal at once: ${String(files.length)}`);
  for (const file of files) validatePath(file.path);
  checkPathCollisions(files.map((file) => file.path));

  if (!input.output.toLowerCase().endsWith(".dseal")) throw new UserError("The output must be a .dseal file");
  const output = join(await resolveInRoots(dirname(input.output), roots), basename(input.output));
  if (await lstat(output).then(() => true, () => false)) throw new OutputExistsError(input.output);

  const sizes = files.map((file) => ("source" in file ? file.source.size : file.data.length));
  const totalSize = sizes.reduce((sum, size) => sum + size, 0);
  const anchor = input.anchor;
  const intent = toHex(
    hash(
      utf8(
        JSON.stringify({
          files: files.map((file, i) => [file.path, sizes[i]]),
          output,
          role: input.role,
          title: input.title ?? null,
          anchor,
          signer,
        }),
      ),
    ),
  );
  const names = files.slice(0, SHOWN_NAMES).map((file) => `  ${fence(file.path)}`);
  const more = files.length > SHOWN_NAMES ? [`  … and ${String(files.length - SHOWN_NAMES)} more`] : [];
  const message = [
    `An AI agent asks DocSeal to sign ${count(files.length, "file")} (${formatSize(totalSize)}) with your key.`,
    "",
    `Signer: ${signer}`,
    `Role:   ${fence(input.role)}`,
    ...(input.title === undefined ? [] : [`Title:  ${fence(input.title)}`]),
    `Save to: ${fence(output)}`,
    anchor ? "The seal's digest goes to the OpenTimestamps calendars; the documents stay here." : "No proof of time.",
    "",
    "Files:",
    ...names,
    ...more,
    "",
    "Sign only if you meant to sign exactly these files.",
  ].join("\n");
  return { files, output, intent, message };
}

/** Opens the key, seals, and drops the key. Nothing is written unless the package is complete. */
export async function seal(
  plan: Plan,
  input: SealInput,
  options: { key: string; env: Readonly<Record<string, string | undefined>>; fetch?: Fetch | undefined; generator: string },
): Promise<SealOutput> {
  const passphrase = options.env[PASSPHRASE_ENV];
  if (passphrase === undefined) throw new UserError(`${PASSPHRASE_ENV} is not set in the server's environment`);
  const { seed, did } = await openKey(options.key, () => Promise.resolve(passphrase));
  try {
    const docseal = createDocSeal({ fetch: options.fetch, anchor: input.anchor });
    const result = await withOutput(plan.output, { overwrite: false }, (sink) =>
      docseal.sealTo(sink, {
        files: plan.files,
        signer: memoryKeyProvider(seed),
        role: input.role,
        ...(input.title === undefined ? {} : { metadata: { title: input.title } }),
        generator: options.generator,
      }),
    );
    return {
      summary: `Sealed ${count(plan.files.length, "file")} into ${fence(plan.output)}. ${
        input.anchor ? "Its time proof is pending: call upgrade on it in a few hours." : "It has no proof of time."
      }`,
      sealed: true,
      output: fence(plan.output),
      signer: did,
      files: plan.files.length,
      seal: result.seal,
      time: input.anchor ? "pending" : "none",
    };
  } finally {
    seed.fill(0);
  }
}

/** The answer when nothing was sealed because the person did not confirm. */
export function notSealed(reason: string): SealOutput {
  return { summary: `Nothing was sealed: ${reason}`, sealed: false };
}

export const MAX_PATHS = MAX_ITEMS;

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function formatSize(bytes: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${String(bytes)} bytes` : `${value.toFixed(1)} ${units[unit] ?? ""}`;
}
