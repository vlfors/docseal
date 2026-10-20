/**
 * The network of the end-to-end tests: every request a page or its workers make outside the
 * test server is answered by the fake calendars and Esplora of tests/fake-network.ts, or
 * refused. The real calendars and chain sources are never contacted.
 */
import type { BrowserContext } from "playwright";
import { fakeNetwork } from "../fake-network";

export type FakeNetwork = ReturnType<typeof fakeNetwork>;

/** Origins the site contacts (network.js), served by the fake network under its own names. */
const ESPLORA = /^https:\/\/(mempool\.space|blockstream\.info)\/api/;

export async function useFakeNetwork(context: BrowserContext, site: string, network: FakeNetwork = fakeNetwork()): Promise<FakeNetwork> {
  await context.route(
    // Only the network: WebKit routes blob: URLs too, through which a worker reads a chosen file.
    (url) => (url.protocol === "https:" || url.protocol === "http:") && !url.href.startsWith(site),
    async (route) => {
      const request = route.request();
      // The site's Esplora sources are the fake one; calendars keep their own addresses.
      const url = request.url().replace(ESPLORA, "https://esplora.test");
      const body = request.postDataBuffer();
      const response = await network.fetch(url, { method: request.method(), ...(body && { body: new Uint8Array(body) }) });
      await route.fulfill({
        status: response.status,
        headers: { "access-control-allow-origin": "*" },
        body: Buffer.from(await response.arrayBuffer()),
      });
    },
  );
  return network;
}
