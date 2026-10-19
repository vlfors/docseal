// The page's language: the viewer's saved choice, else the browser's. The choice is a per-viewer
// convenience kept in localStorage; without storage the page still works in the chosen language.
import { chooseLanguage, MESSAGES } from "./language";
import type { Language, Messages } from "./messages";

const STORAGE_KEY = "docseal.language";

const state = $state<{ language: Language }>({ language: "en" });

function apply(language: Language): void {
  state.language = language;
  document.documentElement.lang = language;
}

/** Called once the page runs in the browser (the prerendered shell is in English). */
export function initLanguage(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked: fall back to the browser's languages.
  }
  apply(chooseLanguage(saved, navigator.languages));
}

export function setLanguage(language: Language): void {
  apply(language);
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Not remembered; the page still switches.
  }
}

export function language(): Language {
  return state.language;
}

/** The messages of the current language; reading it in a template follows the switch. */
export function t(): Messages {
  return MESSAGES[state.language];
}
