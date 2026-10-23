/**
 * Characters that can change what a terminal shows rather than being shown: C0 and C1 controls
 * (ANSI escape sequences start with ESC or CSI), and invisible or bidirectional formatting
 * marks that reorder text. Anything taken from a package passes through here before printing,
 * so a crafted role or file name cannot redraw the verdict.
 */
const UNSAFE = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" + // C0, DEL, C1
    "\\u061c\\u200b-\\u200f" + // Arabic letter mark, zero-width and directional marks
    "\\u2028-\\u202e\\u2060-\\u2069\\ufeff" + // line/paragraph separators, bidi embeddings and isolates, BOM
    "]",
  "g",
);

export function sanitize(text: string): string {
  return text.replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
