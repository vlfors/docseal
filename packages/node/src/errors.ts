/** An expected failure the person can fix (a missing file, a link, a wrong path): shown as one line, without a stack trace. */
export class UserError extends Error {
  override readonly name: string = "UserError";
}
