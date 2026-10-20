/**
 * Text taken from a package (file names, roles, signer ids, messages) is shown as text, never as
 * markup: Svelte escapes it, and {@html} is rejected by ESLint. What escaping does not stop are
 * characters that change how text is shown rather than being shown: controls, and invisible or
 * bidirectional formatting marks that reorder it ("invoice<U+202E>txt.exe" shows as
 * "invoiceexe.txt"). They are the characters the CLI escapes (apps/cli/src/sanitize.ts, checked
 * by text.test.ts), and here each becomes a visible part such as "U+202E".
 */
const UNSAFE = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" + // C0, DEL, C1
    "\\u061c\\u200b-\\u200f" + // Arabic letter mark, zero-width and directional marks
    "\\u2028-\\u202e\\u2060-\\u2069\\ufeff" + // line/paragraph separators, bidi embeddings and isolates, BOM
    "]",
  "g",
);

export type TextPart = { text: string; unsafe: false } | { text: string; unsafe: true; code: string };

/** `text` split into plain runs and the characters that must be shown as their code point. */
export function visibleParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(UNSAFE)) {
    if (match.index > last) {
      parts.push({ text: text.slice(last, match.index), unsafe: false });
    }
    const code = `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    parts.push({ text: match[0], unsafe: true, code });
    last = match.index + 1;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last), unsafe: false });
  }
  return parts;
}

// Without the global flag: `test` on a global expression moves its lastIndex, which `matchAll`
// would then start from.
const ANY_UNSAFE = new RegExp(UNSAFE.source);

/** Whether `text` contains any character that `visibleParts` would mark. */
export function hasUnsafe(text: string): boolean {
  return ANY_UNSAFE.test(text);
}

/** A signer id short enough to read: did:key:z6MkABCDEFGH…WXYZ. Comparisons use the full id. */
export function shortId(id: string): string {
  return id.length > 32 ? `${id.slice(0, 20)}…${id.slice(-6)}` : id;
}

/** At most `max` characters of `text`; a longer value (a 100 000-digit signer) says how long it is. */
export function clip(text: string, max = 200): { text: string; length?: number } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, length: text.length } : { text };
}
