import { parseArgs } from "node:util";

/** What the person running the server allows. Nothing here comes from the agent. */
export interface Config {
  /** Directories the tools may read and write under; none means no file access. */
  roots: string[];
  /** trusted-keys.json; without it trust is not evaluated. */
  trust?: string | undefined;
  /** Esplora APIs for Bitcoin block headers, tried in order; empty means the defaults. */
  chain: string[];
  offline: boolean;
  /** Key file for `seal`; set only together with --allow-seal. */
  key?: string | undefined;
}

export type Command = { kind: "serve"; config: Config } | { kind: "help" } | { kind: "version" };

export const USAGE = `Usage: docseal-mcp [options]

DocSeal MCP server. An MCP client starts it and talks to it over stdin and stdout.

Options:
  --root <dir>      directory the tools may read and write under; repeat for more.
                    Without one, the tools cannot open any file
  --trust <file>    trusted-keys.json listing the signers you accept
  --chain <url>     Esplora API for Bitcoin block headers; repeat for fallbacks
  --offline         do not contact a chain source; time proofs stay unchecked
  --allow-seal      offer the seal tool; each seal still needs your confirmation
  --key <file>      key file to seal with (requires --allow-seal); its passphrase
                    comes from DOCSEAL_PASSPHRASE in the server's environment
  -h, --help        show this help
  -v, --version     show the version
`;

/** An argument the server cannot start with: printed with the usage, exit code 2. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function parseCommand(argv: readonly string[]): Command {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        root: { type: "string", multiple: true, default: [] },
        trust: { type: "string" },
        chain: { type: "string", multiple: true, default: [] },
        offline: { type: "boolean", default: false },
        "allow-seal": { type: "boolean", default: false },
        key: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    }));
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  if (values["allow-seal"] !== (values.key !== undefined)) {
    throw new ConfigError("--allow-seal and --key go together: sealing needs both");
  }
  if (values.offline && values.chain.length > 0) {
    throw new ConfigError("--offline and --chain contradict each other");
  }
  return {
    kind: "serve",
    config: { roots: values.root, trust: values.trust, chain: values.chain, offline: values.offline, key: values.key },
  };
}
