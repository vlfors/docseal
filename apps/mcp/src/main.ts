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
}

export interface Running {
  close(): Promise<void>;
}

/** Starts serving, or prints help or the version. Returns the exit code when there is nothing to serve. */
export function main(argv: readonly string[], io: Io): Running | number {
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
      io.stderr(
        `${NAME} ${VERSION}: serving on stdio; ` +
          `${config.roots.length > 0 ? `files under ${config.roots.join(", ")}` : "no file access (no --root)"}; ` +
          `sealing ${config.key === undefined ? "off" : "on"}\n`,
      );
      return serveStdio(() => createServer(), {
        ...(io.transport ? { transport: io.transport } : {}),
        onerror: (error) => {
          io.stderr(`${NAME}: ${error.message}\n`);
        },
      });
    }
  }
}
