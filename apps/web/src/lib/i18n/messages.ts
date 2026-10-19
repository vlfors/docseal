// Every string the page shows, per language. Each dictionary is typed as Messages, so a missing
// or extra translation fails the type check. Text from a package is never part of a message:
// functions take it as an argument only where the page shows it in its own element.
import type { AxisVerdicts, FileResult, OverallVerdict } from "@docseal/core";

export type Axis = keyof AxisVerdicts;

export type Language = "en" | "ru";

export interface Messages {
  /** The language's name in itself, for the switch. */
  languageName: string;
  tagline: string;
  framed: string;
  footer: string;
  nav: { verify: string; seal: string };

  seal: {
    title: string;
    intro: string;
    filesTitle: string;
    chooseFiles: string;
    chooseFolder: string;
    dropHint: string;
    folderNote: string;
    clear: string;
    remove: (path: string) => string;
    summary: (count: number, size: string) => string;
    problems: (count: number) => string;
    collision: string;
    readingFolder: string;
    empty: string;
  };

  key: {
    title: string;
    note: string;
    openTab: string;
    newTab: string;
    keyFile: string;
    chooseKeyFile: string;
    passphrase: string;
    repeat: string;
    open: string;
    create: string;
    deriving: (percent: number) => string;
    cancel: string;
    wrongPassphrase: string;
    notKeyFile: (reason: string) => string;
    short: string;
    mismatch: string;
    ready: string;
    close: string;
    created: string;
    keepPrivate: string;
    shareTitle: string;
    shareNote: string;
    devOnly: string;
  };

  verify: {
    title: string;
    choose: string;
    dropHint: string;
    privacy: string;
    checking: string;
    progress: (percent: number) => string;
    cancel: string;
    another: string;
    failed: string;
    notDseal: string;
  };

  overall: Record<OverallVerdict, { headline: string; explanation: string }>;
  axes: Record<Axis, { name: string; question: string }>;
  verdicts: { [A in Axis]: Record<AxisVerdicts[A], string> };
  details: {
    filesMatch: (ok: number, total: number) => string;
    noLaterThan: (time: string) => string;
    confirmations: (count: number) => string;
    via: string;
  };

  sections: {
    files: string;
    allFiles: (count: number) => string;
    signatures: string;
    anchors: string;
    issues: string;
    nextSteps: string;
    technical: string;
  };
  fileStatus: Record<FileResult["status"], string>;
  signature: {
    signer: string;
    role: string;
    claimedAt: string;
    claimedAtNote: string;
    check: string;
    trust: string;
    entry: string;
  };
  anchor: {
    provider: string;
    verdict: string;
    attestedAt: string;
    source: string;
  };
  technical: {
    packageId: string;
    seal: string;
    merkleRoot: string;
    statementHash: string;
  };
  issueNote: string;
  hints: {
    trustNotEvaluated: string;
    timePending: string;
    timeMissing: string;
    timeUnsupported: string;
  };
  disclaimer: string;
  unsafeCharacter: (code: string) => string;

  trusted: {
    title: string;
    note: string;
    empty: string;
    did: string;
    label: string;
    add: string;
    remove: (label: string) => string;
    import: string;
    export: string;
    imported: (added: number, skipped: number) => string;
    invalidDid: string;
    duplicate: string;
    invalidFile: (reason: string) => string;
    storageUnavailable: string;
  };
}
