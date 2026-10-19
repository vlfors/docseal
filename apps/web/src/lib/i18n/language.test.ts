import { describe, expect, it } from "vitest";
import { chooseLanguage, formatSize, formatTime, MESSAGES } from "./language";

describe("chooseLanguage", () => {
  it("prefers a saved choice, then the browser's languages, then English", () => {
    expect(chooseLanguage("ru", ["en-US"])).toBe("ru");
    expect(chooseLanguage(null, ["de-DE", "ru-RU", "en"])).toBe("ru");
    expect(chooseLanguage(null, ["RU"])).toBe("ru");
    expect(chooseLanguage(null, ["de", "fr"])).toBe("en");
    expect(chooseLanguage("xx", [])).toBe("en");
  });
});

describe("formatTime", () => {
  it("names the time zone and keeps an unreadable value as it is", () => {
    expect(formatTime("2026-10-16T12:00:00Z", "en")).toMatch(/October 16, 2026.*12:00:00.*UTC/);
    expect(formatTime("2026-10-16T12:00:00Z", "ru")).toMatch(/16 октября 2026.*12:00:00.*UTC/);
    expect(formatTime("not a time", "en")).toBe("not a time");
  });
});

describe("dictionaries", () => {
  // The type check already requires every key; this catches an empty or untranslated string.
  it("have no empty strings, and Russian differs from English", () => {
    const strings = (value: unknown, path: string): [string, string][] =>
      typeof value === "string"
        ? [[path, value]]
        : typeof value === "object" && value !== null
          ? Object.entries(value).flatMap(([key, child]) => strings(child, `${path}.${key}`))
          : [];
    const english = new Map(strings(MESSAGES.en, ""));
    for (const [path, text] of strings(MESSAGES.ru, "")) {
      expect(text.trim(), path).not.toBe("");
      expect(text === english.get(path) && /[a-z]{4}/i.test(text), `${path} is untranslated`).toBe(false);
    }
  });
});

describe("formatSize", () => {
  it("uses decimal units in the page's language", () => {
    expect(formatSize(3, "en")).toBe("3 bytes");
    expect(formatSize(3, "ru")).toBe("3 байта");
    expect(formatSize(1_400_000, "en")).toBe("1.4 MB");
    expect(formatSize(2 * 1024 ** 3, "ru")).toMatch(/^2,1\sГБ$/);
  });
});
