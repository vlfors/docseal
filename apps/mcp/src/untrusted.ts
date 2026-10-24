import { sanitize } from "@docseal/node";

/**
 * Text from a package reaches the model only as values of named fields, and only through
 * here: characters that hide or reorder text are made visible, and each value and each list
 * is capped, so a crafted package can neither disguise its text nor flood the model's context.
 */

/** Characters of one value from a package. A did:key is 56; a path may be up to 1024 bytes. */
export const MAX_TEXT = 256;
/** Entries of one list. */
export const MAX_ITEMS = 100;

export function fence(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_TEXT) {
    return sanitize(text);
  }
  return `${sanitize(chars.slice(0, MAX_TEXT).join(""))}… [${String(chars.length - MAX_TEXT)} more characters]`;
}

/** Fences every string inside a value taken from a package. Enum values pass unchanged: they are short and safe. */
export function fenceAll<T>(value: T): T {
  if (typeof value === "string") {
    return fence(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(fenceAll) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fenceAll(item)])) as T;
  }
  return value;
}

/** Keeps at most MAX_ITEMS entries, those that `first` picks ahead of the rest, and says how many were left out. */
export function capList<T>(items: readonly T[], first: (item: T) => boolean = () => false): { kept: T[]; omitted: number } {
  if (items.length <= MAX_ITEMS) {
    return { kept: [...items], omitted: 0 };
  }
  const kept = [...items.filter(first), ...items.filter((item) => !first(item))].slice(0, MAX_ITEMS);
  return { kept, omitted: items.length - kept.length };
}
