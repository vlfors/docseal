import { DEFAULT_ESPLORA_URLS, DEFAULT_MIN_CONFIRMATIONS } from "@docseal/anchor-ots";
import {
  FORMAT_VERSION,
  FormatError,
  openContainer,
  parseAnchorFile,
  parseJson,
  utf8,
  type ByteSource,
  type VerificationReport,
} from "@docseal/core";
import {
  OutputExistsError,
  PASSPHRASE_ENV,
  UserError,
  collectFiles,
  createDocSeal,
  createOutput,
  openFileSource,
  openKey,
  readInput,
  readTrustedKeys,
  sanitize,
  withOutput,
  writeOutput,
  type OutputFile,
} from "@docseal/node";
import {
  DEFAULT_SCRYPT_N,
  KeyFileError,
  createKeyFile,
  generateSecretKey,
  keyFilePublicKey,
  memoryKeyProvider,
} from "@docseal/sig-ed25519";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { CliError, ExitCode, type Io } from "./io.js";
import { formatReport } from "./report.js";

export const VERSION = "0.2.0";

/** Runs the CLI and returns the exit code. Never calls process.exit. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let exitCode: number = ExitCode.Valid;
  const program = new Command()
    .name("docseal")
    .description("Create and verify portable proofs of document integrity, signature, and time.")
    .version(`${VERSION} (format v${String(FORMAT_VERSION)})`)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        io.stdout(text);
      },
      writeErr: (text) => {
        io.stderr(text);
      },
    })
    .showHelpAfterError();

  program
    .command("keygen")
    .description("Create an Ed25519 key file encrypted with a passphrase (for development use).")
    .requiredOption("-o, --output <file>", "where to write the key file")
    .option("--force", "overwrite an existing file")
    .addOption(new Option("--scrypt-n <n>", "scrypt cost (tests only)").argParser(integer).hideHelp())
    .action(async (options: { output: string; force?: boolean; scryptN?: number }) => {
      const passphrase = await newPassphrase(io);
      const file = await createKeyFile(generateSecretKey(), passphrase, { scryptN: options.scryptN ?? DEFAULT_SCRYPT_N });
      await writeOutput(options.output, utf8(`${JSON.stringify(file, null, 2)}\n`), {
        overwrite: options.force === true,
        mode: 0o600,
      });
      io.stdout(
        [
          `Created ${options.output}`,
          `Public key: ${file.publicKey}`,
          "",
          "Recipients who should trust this key can add it to their trusted-keys.json:",
          JSON.stringify({ type: "docseal-trusted-keys", version: 1, keys: [{ id: file.publicKey, label: "Your name" }] }, null, 2),
          "",
          "This key file is for development. Keep production keys in an HSM, KMS, or hardware token.",
          "",
        ].join("\n"),
      );
    });

  program
    .command("pubkey")
    .description("Print the public key (did:key) of a key file. No passphrase needed.")
    .argument("<keyfile>")
    .action(async (keyfile: string) => {
      io.stdout(`${keyFilePublicKey(await readInput(keyfile, "key file"))}\n`);
    });

  program
    .command("seal")
    .description("Sign files or folders into a .dseal package and submit its seal to OpenTimestamps.")
    .argument("<paths...>", "files and folders to include")
    .requiredOption("-k, --key <file>", "key file created by `docseal keygen`")
    .requiredOption("-o, --output <file>", "package to create, e.g. contract.dseal")
    .option("--role <role>", "signer role recorded in the signature", "author")
    .option("--title <title>", "package title stored in the manifest")
    .option("--no-anchor", "do not submit to OpenTimestamps (the package will have no time proof)")
    .option("--calendar <url...>", "OpenTimestamps calendars to submit to")
    .option("--force", "overwrite an existing package")
    .action(
      async (
        paths: string[],
        options: { key: string; output: string; role: string; title?: string; anchor: boolean; calendar?: string[]; force?: boolean },
      ) => {
        const files = await collectFiles(paths);
        const { seed, did } = await openKey(options.key, () => passphrase(io, `Passphrase for ${options.key}: `));
        const docseal = createDocSeal({ fetch: io.fetch, anchor: options.anchor, calendars: options.calendar });
        const result = await withOutput(options.output, { overwrite: options.force === true }, (sink) =>
          docseal.sealTo(sink, {
            files,
            signer: memoryKeyProvider(seed),
            role: options.role,
            ...(options.title === undefined ? {} : { metadata: { title: options.title } }),
            generator: `docseal-cli/${VERSION}`,
          }),
        ).finally(() => seed.fill(0));
        io.stdout(
          [
            `Sealed ${String(files.length)} file${files.length === 1 ? "" : "s"} into ${options.output}`,
            `Signer: ${did}`,
            `Seal:   ${result.seal}`,
            options.anchor
              ? `Time:   pending; run \`docseal upgrade ${options.output}\` in a few hours to complete the proof`
              : "Time:   none (sealed with --no-anchor)",
            "",
          ].join("\n"),
        );
      },
    );

  program
    .command("verify")
    .description("Verify a .dseal package. Exit code: 0 valid, 1 invalid, 2 indeterminate, 3 error.")
    .argument("<package>")
    .option("-t, --trust <file>", "trusted-keys.json listing the signers you accept")
    .option("--json", "print the machine-readable report")
    .option(
      "--chain <url>",
      "Esplora API used to read Bitcoin block headers; repeat for fallbacks, tried in order",
      collectUrls,
      DEFAULT_ESPLORA_URLS,
    )
    .option("--offline", "do not contact the chain source; time proofs stay unchecked")
    .option("--min-confirmations <n>", "Bitcoin confirmations required", integer, DEFAULT_MIN_CONFIRMATIONS)
    .action(
      async (
        path: string,
        options: { trust?: string; json?: boolean; chain: string[]; offline?: boolean; minConfirmations: number },
      ) => {
        const docseal = createDocSeal({
          fetch: io.fetch,
          minConfirmations: options.minConfirmations,
          trust: options.trust ? await readTrustedKeys(options.trust) : undefined,
          chain: options.offline ? undefined : options.chain,
        });
        const source = await openFileSource(path, "package");
        const report = await docseal.verify(source).finally(() => source.close());
        io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
        exitCode = exitCodeFor(report);
      },
    );

  program
    .command("upgrade")
    .description("Complete pending OpenTimestamps proofs once calendars have committed to Bitcoin.")
    .argument("<package>")
    .option("-o, --output <file>", "write the upgraded package here instead of in place")
    .action(async (path: string, options: { output?: string }) => {
      const docseal = createDocSeal({ fetch: io.fetch });
      const target = options.output ?? path;
      const source = await openFileSource(path, "package");
      let output: OutputFile | undefined;
      let changed: boolean;
      try {
        // Written only if something changed, or a separate output was asked for.
        ({ changed } = await docseal.upgradeTo(source, async (didChange) =>
          didChange || options.output ? (output = await createOutput(target, { overwrite: true })) : undefined,
        ));
        await source.close();
        await output?.commit();
      } finally {
        await output?.abort();
        await source.close().catch(() => undefined);
      }
      io.stdout(`${changed ? `Upgraded ${target}` : "No change: calendars have not committed to Bitcoin yet."}\n`);
      const result = await openFileSource(target, "package");
      try {
        for (const line of await receiptSummary(result)) {
          io.stdout(`  ${sanitize(line)}\n`);
        }
      } finally {
        await result.close();
      }
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? ExitCode.Valid : ExitCode.Error;
    }
    if (error instanceof OutputExistsError) {
      io.stderr(`docseal: ${sanitize(error.message)}; use --force to overwrite\n`);
      return ExitCode.Error;
    }
    if (error instanceof UserError || error instanceof KeyFileError || error instanceof FormatError) {
      io.stderr(`docseal: ${sanitize(error.message)}\n`);
      return ExitCode.Error;
    }
    io.stderr(`docseal: ${sanitize(error instanceof Error ? error.message : String(error))}\n`);
    return ExitCode.Error;
  }
}

function exitCodeFor(report: VerificationReport): number {
  switch (report.overall) {
    case "valid":
      return ExitCode.Valid;
    case "invalid":
      return ExitCode.Invalid;
    case "indeterminate":
      return ExitCode.Indeterminate;
  }
}

async function receiptSummary(source: ByteSource): Promise<string[]> {
  const lines: string[] = [];
  for (const [entry, bytes] of (await openContainer(source)).anchors) {
    for (const receipt of parseAnchorFile(parseJson(bytes)).receipts) {
      const status = receipt.cached?.status ?? "unknown";
      const block = receipt.cached?.blockHeight === undefined ? "" : ` at block ${String(receipt.cached.blockHeight)}`;
      lines.push(`${entry}: ${receipt.provider} ${status}${block}`);
    }
  }
  return lines.length > 0 ? lines : ["The package has no time proof."];
}

async function passphrase(io: Io, prompt: string): Promise<string> {
  const fromEnv = io.env[PASSPHRASE_ENV];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  try {
    return await io.readSecret(prompt);
  } catch {
    throw new CliError(`No terminal to ask for the passphrase; set ${PASSPHRASE_ENV}`);
  }
}

async function newPassphrase(io: Io): Promise<string> {
  if (io.env[PASSPHRASE_ENV] !== undefined) {
    return passphrase(io, "");
  }
  const first = await passphrase(io, "New passphrase: ");
  if (first.length < 8) {
    throw new CliError("Use a passphrase of at least 8 characters");
  }
  if ((await passphrase(io, "Repeat passphrase: ")) !== first) {
    throw new CliError("Passphrases do not match");
  }
  return first;
}

function integer(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new InvalidArgumentError("Expected a non-negative integer");
  }
  return n;
}

/** A repeatable --chain: the first one given replaces the defaults, later ones are fallbacks. */
function collectUrls(value: string, previous: string[]): string[] {
  return previous === DEFAULT_ESPLORA_URLS ? [value] : [...previous, value];
}
