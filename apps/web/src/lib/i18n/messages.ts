// Every string the page shows, per language. Each dictionary is typed as Messages, so a missing
// or extra translation fails the type check. Text from a package is never part of a message:
// functions take it as an argument only where the page shows it in its own element.
import type { AxisVerdicts, FileResult, OverallVerdict } from "@docseal/core";

export type Axis = keyof AxisVerdicts;

export type Language = "en" | "ru";

export interface Messages {
  /** The language's name in itself, for the switch. */
  languageName: string;
  framed: string;
  footer: string;
  builtFrom: string;
  preview: string;
  localBuild: string;
  nav: { verify: string; seal: string; upgrade: string };

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

  sealing: {
    title: string;
    role: string;
    roleNote: string;
    seal: string;
    needFiles: string;
    needKey: string;
    fixPaths: string;
    /** The steps of a sealing, as the log shows them. */
    steps: { hashing: string; signing: string; timestamping: string; writing: string };
    stepsLabel: string;
    percent: (percent: number) => string;
    calendarWaiting: string;
    calendarAccepted: string;
    calendarFailed: string;
    cancel: string;
    cancelled: string;
    done: string;
    savedTo: (name: string) => string;
    downloaded: (name: string) => string;
    keyClosed: string;
    verifyIt: string;
    upgradeIt: string;
    changed: string;
    tooLarge: (limit: string) => string;
    tooLargeHint: string;
    memoryNote: (limit: string) => string;
    failed: string;
    seal_: string;
    size: string;
    timestamp: string;
    timestampNote: string;
    calendars: string;
    noTimestamp: string;
    calendarsFailed: string;
    pendingNote: string;
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

  chain: {
    title: string;
    source: string;
    summary: (source: string) => string;
    publicSources: string;
    custom: string;
    customUrl: string;
    offline: string;
    trustNote: string;
    privacyNote: string;
    invalidUrl: string;
  };

  upgrade: {
    title: string;
    check: string;
    checking: string;
    notYet: string;
    available: string;
    save: string;
    saving: (percent: number) => string;
    saved: (name: string) => string;
    downloaded: (name: string) => string;
    failed: string;
    /** The three stages of a time proof, as the tracker shows them. */
    stages: { submitted: string; inBlock: string; confirmed: string };
    submittedAgo: (ago: string) => string;
    waitingCalendar: string;
    block: (height: number) => string;
    viewBlock: string;
    confirmations: (count: number, required: number) => string;
    remaining: (about: string) => string;
    confirmedNote: string;
    saveNow: string;
    auto: (every: string) => string;
    lastChecked: (time: string) => string;
    noChain: string;
    rechecking: string;
  };

  /** A duration such as "1 h 20 min", from minutes. */
  duration: (minutes: number) => string;

  verify: {
    title: string;
    choose: string;
    dropHint: string;
    privacy: string;
    checking: string;
    progress: (percent: number) => string;
    cancel: string;
    failed: string;
    notDseal: string;
    chooseAnother: string;
    settings: string;
    settingsSummary: (keys: number, chain: string) => string;
    /** Shown above the report of a package whose time proof is not finished. */
    needsUpgrade: { title: string; text: string; action: string };
  };

  /** The page that completes a package's pending time proof. */
  upgradePage: {
    title: string;
    intro: string;
    done: string;
    doneDetail: (time: string) => string;
    verifyFully: string;
    missing: string;
    invalid: string;
    unsupported: string;
  };

  overall: Record<OverallVerdict, { headline: string; explanation: string }>;
  axes: Record<Axis, { name: string; question: string }>;
  verdicts: { [A in Axis]: Record<AxisVerdicts[A], string> };
  details: {
    filesMatch: (ok: number, total: number) => string;
    noLaterThan: (time: string) => string;
    /** `height`: the block, when the report names it. */
    confirmations: (count: number, height?: number) => string;
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
    checks: string;
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
    block: string;
    confirmations: string;
    submittedAt: string;
    submittedAtNote: string;
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
    timeOffline: string;
  };
  hintActions: {
    addKey: string;
    configure: string;
    upgrade: string;
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
