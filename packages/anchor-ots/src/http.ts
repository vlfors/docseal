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

/**
 * GET or POST with a timeout and a cap on the response size. Throws HttpError.
 * Redirects are refused: an allow-listed calendar must not forward us to another host.
 * The body is read incrementally and abandoned as soon as it exceeds the cap.
 */
export async function request(
  url: string,
  init: RequestInit & { maxBytes: number },
  options: HttpOptions,
): Promise<Uint8Array> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const { maxBytes, ...fetchInit } = init;
  const tooLarge = () => new HttpError(`${url}: response is larger than ${String(maxBytes)} bytes`);
  let response: Response;
  try {
    response = await fetchFn(url, {
      ...fetchInit,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HttpError(`${url}: ${describe(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(`${url}: HTTP ${String(response.status)}`, response.status);
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > maxBytes) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(`${url}: ${describe(error)}`);
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** Node's fetch reports "fetch failed" and hides the reason (DNS, TLS, refused) in `cause`. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause ? `${error.message} (${cause})` : error.message;
}
