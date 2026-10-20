/**
 * fetch for the anchor packages in a browser. Calendars and Esplora instances allow
 * cross-origin requests, but none answers a CORS preflight (OPTIONS gives 404 or 501, checked
 * 2026-10-20), so every request must be a simple one: the User-Agent header the packages set for
 * the CLI is dropped. Nothing is sent but the request itself: no cookies, no referrer.
 *
 * A calendar answers "not committed yet" (404) to an upgrade without CORS headers, which a
 * browser reports as a network error indistinguishable from an unreachable calendar. For
 * upgrades only, that error is read as the 404 it most likely is: the proof stays pending, as
 * the CLI leaves it on a 404, and the page says it may be either.
 *
 * The page's <meta> Content Security Policy does not reach its workers (on GitHub Pages they get
 * no policy at all), so this fetch is the workers' connect-src: it refuses every origin but the
 * calendars, upgrade hosts, and chain sources of network.js, and the viewer's own Esplora.
 */
import { isAllowed, type Fetch } from "@docseal/anchor-ots";
import { CONNECT_SOURCES } from "../../network.js";

const UPGRADE_PATH = /\/timestamp\/[0-9a-f]+$/;

export interface BrowserFetch extends Fetch {
  /** Origins of the calendars that accepted a digest, in the order they answered. */
  readonly acceptedCalendars: readonly string[];
}

/** A request to an origin the page may not contact. */
export class NotAllowed extends Error {
  override name = "NotAllowed";
}

/** Whether `url` is on one of CONNECT_SOURCES or exactly one of `extra` (origins). */
export function mayContact(url: string, extra: readonly string[] = []): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return extra.includes(origin) || isAllowed(origin, CONNECT_SOURCES);
}

/** `extraOrigins`: further origins this fetch may contact, such as the viewer's own Esplora. */
export function browserFetch(base: Fetch = (input, init) => fetch(input, init), extraOrigins: readonly string[] = []): BrowserFetch {
  const accepted: string[] = [];
  const wrapped = async (url: string, init: RequestInit = {}) => {
    if (!mayContact(url, extraOrigins)) {
      throw new NotAllowed(`${url} is not a source this page may contact`);
    }
    const headers = new Headers(init.headers);
    headers.delete("user-agent");
    const method = (init.method ?? "GET").toUpperCase();
    try {
      const response = await base(url, { ...init, headers, mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
      if (method === "POST" && url.endsWith("/digest") && response.ok) {
        accepted.push(new URL(url).origin);
      }
      return response;
    } catch (error) {
      if (method === "GET" && UPGRADE_PATH.test(url) && error instanceof TypeError) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }
  };
  return Object.assign(wrapped, { acceptedCalendars: accepted });
}
