/**
 * A package that cannot be processed. `verdict` says whether it is broken (`invalid`)
 * or uses something this verifier does not implement (`unsupported`).
 */
export class FormatError extends Error {
  override readonly name = "FormatError";

  constructor(
    readonly code: string,
    message: string,
    readonly verdict: "invalid" | "unsupported" = "invalid",
  ) {
    super(message);
  }
}
