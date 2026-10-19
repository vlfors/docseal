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

/** A proven time in UTC, written out for `language`; the zone is always named. */
export function formatTime(iso: string, language: Language): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(language, { dateStyle: "long", timeStyle: "long", timeZone: "UTC" }).format(date);
}
