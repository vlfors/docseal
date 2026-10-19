import { en } from "./en";
import type { Language, Messages } from "./messages";
import { ru } from "./ru";

export const MESSAGES: Record<Language, Messages> = { en, ru };
export const LANGUAGES = Object.keys(MESSAGES) as Language[];

/** The saved choice if there is one, else the first of the browser's languages we have, else English. */
export function chooseLanguage(saved: string | null, preferred: readonly string[]): Language {
  const known = (tag: string) => LANGUAGES.find((language) => tag.toLowerCase().split("-")[0] === language);
  return (saved && known(saved)) || preferred.map(known).find((language) => language !== undefined) || "en";
}

/** A size for people: 3 bytes, 1.4 MB, 2.1 GB (decimal units, as file managers show them). */
export function formatSize(bytes: number, language: Language): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(language, { style: "unit", unit: units[unit], unitDisplay: unit === 0 ? "long" : "short", maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
}

/** A proven time in UTC, written out for `language`; the zone is always named. */
export function formatTime(iso: string, language: Language): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(language, { dateStyle: "long", timeStyle: "long", timeZone: "UTC" }).format(date);
}
