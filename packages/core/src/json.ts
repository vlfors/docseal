import canonicalize from "canonicalize";
import { utf8 } from "./bytes.js";
import { FormatError } from "./errors.js";

/** RFC 8785 canonical form of `value`, as UTF-8 bytes. */
export function jcs(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new TypeError("Value has no JSON representation");
  }
  return utf8(text);
}

const MAX_DEPTH = 64;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// eslint-disable-next-line no-control-regex -- JSON forbids raw control characters in strings
const PLAIN_CHARS = /[^"\\\u0000-\u001f]+/y;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/**
 * Parses I-JSON (RFC 7493) strictly. Unlike `JSON.parse`, rejects duplicate keys,
 * a byte-order mark, invalid UTF-8, lone surrogates, non-finite numbers, and deep nesting.
 * Objects have a null prototype, so a `__proto__` key is plain data.
 */
export function parseJson(bytes: Uint8Array): unknown {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw jsonError("byte-order mark is not allowed");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw jsonError("invalid UTF-8");
  }
  return new Parser(text).parseDocument();
}

class Parser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parseDocument(): unknown {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw this.error("unexpected data after the document");
    }
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw this.error("nesting is too deep");
    }
    this.skipWhitespace();
    const char = this.text[this.pos];
    switch (char) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        return this.parseNumber();
    }
  }

  private parseObject(depth: number): Record<string, unknown> {
    const object = Object.create(null) as Record<string, unknown>;
    this.pos++;
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return object;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') {
        throw this.error("expected a string key");
      }
      const key = this.parseString();
      if (Object.hasOwn(object, key)) {
        throw this.error(`duplicate key ${JSON.stringify(key)}`);
      }
      this.skipWhitespace();
      this.expect(":");
      object[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      if (this.text[this.pos] === ",") {
        this.pos++;
        continue;
      }
      this.expect("}");
      return object;
    }
  }

  private parseArray(depth: number): unknown[] {
    const array: unknown[] = [];
    this.pos++;
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return array;
    }
    for (;;) {
      array.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.text[this.pos] === ",") {
        this.pos++;
        continue;
      }
      this.expect("]");
      return array;
    }
  }

  private parseString(): string {
    this.pos++;
    let out = "";
    for (;;) {
      PLAIN_CHARS.lastIndex = this.pos;
      const plain = PLAIN_CHARS.exec(this.text);
      if (plain) {
        out += plain[0];
        this.pos += plain[0].length;
      }
      const char = this.text[this.pos];
      if (char === '"') {
        this.pos++;
        break;
      }
      if (char !== "\\") {
        throw this.error(char === undefined ? "unterminated string" : "control character in string");
      }
      const escape = this.text[this.pos + 1] ?? "";
      if (escape === "u") {
        const hex = this.text.slice(this.pos + 2, this.pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw this.error("invalid \\u escape");
        }
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.pos += 6;
      } else {
        const decoded = ESCAPES[escape];
        if (decoded === undefined) {
          throw this.error("invalid escape");
        }
        out += decoded;
        this.pos += 2;
      }
    }
    if (!out.isWellFormed()) {
      throw this.error("lone surrogate in string");
    }
    return out;
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (!match) {
      throw this.error("unexpected character");
    }
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw this.error("number out of range");
    }
    this.pos += match[0].length;
    return value;
  }

  private parseLiteral<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) {
      throw this.error("unexpected character");
    }
    this.pos += word.length;
    return value;
  }

  private expect(char: string): void {
    if (this.text[this.pos] !== char) {
      throw this.error(`expected ${JSON.stringify(char)}`);
    }
    this.pos++;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const char = this.text[this.pos];
      if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") {
        return;
      }
      this.pos++;
    }
  }

  private error(message: string): FormatError {
    return jsonError(`${message} at offset ${String(this.pos)}`);
  }
}

function jsonError(message: string): FormatError {
  return new FormatError("json", `Invalid JSON: ${message}`);
}
