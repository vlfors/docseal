/** An expected failure the person can fix (a missing file, a link, a wrong path): shown as one line, without a stack trace. */
export class UserError extends Error {
  override readonly name: string = "UserError";
}

/** A file that would be written already exists, and may not be replaced. */
export class OutputExistsError extends UserError {
  override readonly name: string = "OutputExistsError";
  constructor(readonly path: string) {
    super(`${path} already exists`);
  }
}
