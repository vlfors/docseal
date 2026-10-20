// The viewer's choice of where block headers come from, and its meaning for the worker.
import { DEFAULT_ESPLORA_URLS } from "@docseal/anchor-ots";
import type { ChainSetting } from "../verify/protocol";

export type ChainMode = "public" | "custom" | "offline";

export interface ChainChoice {
  mode: ChainMode;
  /** The viewer's own Esplora API, for mode "custom". */
  url: string;
}

export const DEFAULT_CHOICE: ChainChoice = { mode: "public", url: "" };

/** An Esplora address the page will use: https, or plain http to this computer only. */
export function isEsploraUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  return (url.protocol === "https:" || (url.protocol === "http:" && local)) && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}

export function toSetting(choice: ChainChoice): ChainSetting {
  switch (choice.mode) {
    case "public":
      return { kind: "esplora", urls: DEFAULT_ESPLORA_URLS };
    case "custom":
      return isEsploraUrl(choice.url) ? { kind: "esplora", urls: [choice.url] } : { kind: "offline" };
    case "offline":
      return { kind: "offline" };
  }
}

/** A stored choice, or the default for anything unreadable. */
export function parseChoice(text: string | null): ChainChoice {
  if (text === null) {
    return DEFAULT_CHOICE;
  }
  try {
    const value = JSON.parse(text) as Partial<ChainChoice>;
    const mode = value.mode === "custom" || value.mode === "offline" ? value.mode : "public";
    return { mode, url: typeof value.url === "string" ? value.url : "" };
  } catch {
    return DEFAULT_CHOICE;
  }
}
