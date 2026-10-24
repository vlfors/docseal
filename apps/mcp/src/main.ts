import type { Fetch } from "@docseal/anchor-ots";
import { FormatError } from "@docseal/core";
import { PASSPHRASE_ENV, UserError, openKey } from "@docseal/node";
import { KeyFileError } from "@docseal/sig-ed25519";
import type { Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, USAGE, parseCommand } from "./config.js";
import { NAME, VERSION, createServer } from "./server.js";

/** Everything the server touches besides the file system, so tests can drive it in-process. */
export interface Io {
  /** Only for --help and --version: while serving, stdout carries protocol messages and nothing else. */
  stdout(text: string): void;
  /** Logs and errors. */
  stderr(text: string): void;
  /** Defaults to stdin and stdout. */
  transport?: Transport;
  /** Network access for calendars and the chain source. Defaults to global fetch. */
  fetch?: Fetch;
  /** The server's environment: DOCSEAL_PASSPHRASE for sealing. */
  env: Readonly<Record<string, string | undefined>>;
}

export interface Running {
  close(): Promise<void>;
}

/** Starts serving, or prints help or the version. Returns the exit code when there is nothing to serve. */
export async function main(argv: readonly string[], io: Io): Promise<Running | number> {
  let command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr(`${NAME}: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  switch (command.kind) {
    case "help":
      io.stdout(USAGE);
      return 0;
    case "version":
      io.stdout(`${VERSION}\n`);
      return 0;
    case "serve": {
      const { config } = command;
      let signer: string | undefined;
      if (config.key !== undefined) {
        try {
          signer = await checkKey(config.key, io.env);
        } catch (error) {
          if (!(error instanceof UserError || error instanceof KeyFileError || error instanceof FormatError)) throw error;
          io.stderr(`${NAME}: cannot seal with ${config.key}: ${error.message}\n`);
          return 2;
        }
      }
      io.stderr(
        `${NAME} ${VERSION}: serving on stdio; ` +
          `${config.roots.length > 0 ? `files under ${config.roots.join(", ")}` : "no file access (no --root)"}; ` +
          `sealing ${signer === undefined ? "off" : `on, as ${signer}`}\n`,
      );
      return serveStdio(() => createServer(config, { fetch: io.fetch, env: io.env, ...(signer !== undefined && { signer }) }), {
        ...(io.transport ? { transport: io.transport } : {}),
        onerror: (error) => {
          io.stderr(`${NAME}: ${error.message}\n`);
        },
      });
    }
  }
}

/**
 * Opens the key once at startup, so a missing or wrong passphrase stops the server at once
 * rather than at the first seal; the key is dropped again. Returns the signer's did:key.
 */
async function checkKey(path: string, env: Io["env"]): Promise<string> {
  const passphrase = env[PASSPHRASE_ENV];
  if (passphrase === undefined) {
    throw new UserError(`set ${PASSPHRASE_ENV} in the server's environment (never as an argument)`);
  }
  const { seed, did } = await openKey(path, () => Promise.resolve(passphrase));
  seed.fill(0);
  return did;
}
