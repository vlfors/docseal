// Every origin the page may contact, and nothing else: the Content Security Policy's
// connect-src is built from this list (csp.js), and a test checks it against the
// calendars, upgrade hosts, and chain sources the packages use.

/** OpenTimestamps calendars that accept submissions from a browser (they allow cross-origin requests). */
/** @type {`https://${string}.${string}`[]} */
export const BROWSER_CALENDARS = [
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://a.pool.eternitywall.com",
];

/** Hosts a pending proof may be upgraded from; the same patterns as DEFAULT_UPGRADE_ALLOWLIST. */
/** @type {`https://${string}.${string}`[]} */
export const UPGRADE_HOSTS = [
  "https://*.calendar.opentimestamps.org",
  "https://*.calendar.eternitywall.com",
  "https://*.calendar.catallaxy.com",
];

/** Esplora origins for Bitcoin block headers, as in DEFAULT_ESPLORA_URLS. */
/** @type {`https://${string}.${string}`[]} */
export const CHAIN_ORIGINS = ["https://mempool.space", "https://blockstream.info"];

/** @type {`https://${string}.${string}`[]} */
export const CONNECT_SOURCES = [...BROWSER_CALENDARS, ...UPGRADE_HOSTS, ...CHAIN_ORIGINS];
