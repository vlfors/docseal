// The viewer's trusted keys while the page is open, saved to localStorage on every change.
// If storage is blocked the list still works, for as long as the tab is open, and the page says so.
import type { TrustedKey } from "@docseal/core";
import { loadKeys, saveKeys } from "./keys";

const state = $state({ keys: [] as TrustedKey[], stored: true });

export function initTrustedKeys(): void {
  try {
    state.keys = loadKeys(localStorage);
  } catch {
    state.stored = false;
  }
}

export function trustedKeys(): readonly TrustedKey[] {
  return state.keys;
}

/** Whether the list survives closing the tab. */
export function keysAreStored(): boolean {
  return state.stored;
}

export function setTrustedKeys(keys: TrustedKey[]): void {
  state.keys = keys;
  try {
    saveKeys(localStorage, keys);
    state.stored = true;
  } catch {
    state.stored = false;
  }
}
