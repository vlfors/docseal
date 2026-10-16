import type { Fetch } from "@docseal/anchor-ots";

/** Everything the CLI touches besides the file system, so tests can drive it in-process. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** Network access for calendars and the chain source. Defaults to global fetch. */
  fetch?: Fetch;
  /** Reads a line without echoing it. Rejects when there is no terminal. */
  readSecret(prompt: string): Promise<string>;
}

/** Process exit codes. Scripts can rely on these. */
export const ExitCode = {
  /** Package verified on every axis. */
  Valid: 0,
  /** Package modified, or a signature or time proof is false. */
  Invalid: 1,
  /** Nothing is wrong, but not everything could be confirmed (pending time, untrusted signer, …). */
  Indeterminate: 2,
  /** Bad arguments, unreadable files, network failure while sealing, and similar. */
  Error: 3,
} as const;

/** An expected failure: printed as a one-line message without a stack trace. */
export class CliError extends Error {
  override readonly name = "CliError";
}
