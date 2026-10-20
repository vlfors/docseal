// The viewer's Bitcoin source while the page is open; a per-viewer convenience in localStorage.
import { DEFAULT_CHOICE, parseChoice, type ChainChoice } from "./setting";

const STORAGE_KEY = "docseal.chain";

const state = $state<{ choice: ChainChoice }>({ choice: DEFAULT_CHOICE });

export function initChain(): void {
  try {
    state.choice = parseChoice(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage blocked: the default applies.
  }
}

export function chainChoice(): ChainChoice {
  return state.choice;
}

export function setChainChoice(choice: ChainChoice): void {
  state.choice = choice;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Not remembered; it still applies on this page.
  }
}
