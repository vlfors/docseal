export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: Fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

// Public calendars occasionally take more than 15 s to answer a submission.
const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** GET or POST with a timeout and a cap on the response size. Throws HttpError. */
export async function request(
  url: string,
  init: RequestInit & { maxBytes: number },
  options: HttpOptions,
): Promise<Uint8Array> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (error) {
    throw new HttpError(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new HttpError(`${url}: HTTP ${String(response.status)}`, response.status);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > init.maxBytes) {
    throw new HttpError(`${url}: response is larger than ${String(init.maxBytes)} bytes`);
  }
  return body;
}
