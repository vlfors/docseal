// The Content Security Policy of every page. GitHub Pages cannot send headers, so SvelteKit
// writes it into a <meta> tag on each prerendered page and adds hashes of its own inline
// scripts. Nothing from other origins is loaded, and the page may only talk to the calendars
// and chain sources in network.js. src/csp.test.ts checks this file against its sources.
import { CONNECT_SOURCES } from "./network.js";

/**
 * SvelteKit's route announcer (a visually hidden live region for screen readers) carries this
 * inline style; it is allowed by its hash alone. app.css hides the announcer as well, for a
 * browser that ignores 'unsafe-hashes'.
 */
export const ANNOUNCER_STYLE_HASH = "sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo=";

/** @type {NonNullable<NonNullable<import("@sveltejs/kit/vite").Config["csp"]>["directives"]>} */
export const CSP_DIRECTIVES = {
  "default-src": ["none"],
  "script-src": ["self"],
  "style-src": ["self", "unsafe-hashes", ANNOUNCER_STYLE_HASH],
  "img-src": ["self", "data:"],
  "font-src": ["self"],
  "worker-src": ["self"],
  "connect-src": ["self", ...CONNECT_SOURCES],
  "manifest-src": ["self"],
  "base-uri": ["none"],
  "form-action": ["none"],
  "object-src": ["none"],
};
