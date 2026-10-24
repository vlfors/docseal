import { DEFAULT_MIN_CONFIRMATIONS } from "@docseal/anchor-ots";
import type { DocSeal, VerificationReport } from "@docseal/core";
import { createOutput, type FileSource, type OutputFile } from "@docseal/node";
import { basename, dirname, join } from "node:path";
import { inspectPackage } from "./inspect.js";
import type { UpgradeOutput } from "./schemas.js";
import { fence } from "./untrusted.js";

/** Where the upgraded copy of `real` goes unless the original is replaced: next to it. */
export function upgradedPath(real: string): string {
  return join(dirname(real), `${basename(real).replace(/\.dseal$/i, "")}.upgraded.dseal`);
}

/**
 * Asks the calendars for completed proofs and, if they have them, writes the upgraded package
 * to `target` through a temporary file and a rename, so a failure never leaves half a package.
 * Then reads how far the time proof has come: from the proof itself, and with a chain source
 * from Bitcoin.
 */
export async function upgradePackage(
  docseal: DocSeal,
  source: FileSource,
  target: string,
  reopen: (path: string) => Promise<FileSource>,
  online: boolean,
): Promise<UpgradeOutput> {
  let output: OutputFile | undefined;
  let changed: boolean;
  try {
    ({ changed } = await docseal.upgradeTo(source, async (didChange) =>
      didChange ? (output = await createOutput(target, { overwrite: true })) : undefined,
    ));
    await output?.commit();
  } finally {
    await output?.abort();
  }

  const result = changed ? await reopen(target) : source;
  try {
    const { timeProof } = await inspectPackage(result);
    const report = online ? await docseal.verify(result) : undefined;
    const progress = progressOf(timeProof, report);
    return {
      summary: `${changed ? "Upgraded: the completed proof was written to a new file." : "No change: the calendars have no completed proof yet."} ${STAGE[progress.stage]}`,
      changed,
      ...(changed && { written: fence(target) }),
      ...progress,
      requiredConfirmations: DEFAULT_MIN_CONFIRMATIONS,
      nextSteps: nextSteps(progress.stage, changed, online),
    };
  } finally {
    if (changed) await result.close();
  }
}

type Progress = Pick<UpgradeOutput, "stage" | "blockHeight" | "confirmations">;

function progressOf(timeProof: Awaited<ReturnType<typeof inspectPackage>>["timeProof"], report: VerificationReport | undefined): Progress {
  if (timeProof === "none") return { stage: "none" };
  if (timeProof === "unreadable") return { stage: "unreadable" };
  const confirmed = report?.anchors.find((anchor) => anchor.verdict === "confirmed");
  if (confirmed) {
    return {
      stage: "confirmed",
      ...(confirmed.blockHeight !== undefined && { blockHeight: confirmed.blockHeight }),
      ...(confirmed.confirmations !== undefined && { confirmations: confirmed.confirmations }),
    };
  }
  const inBlock = report?.anchors.find((anchor) => anchor.verdict === "pending" && anchor.blockHeight !== undefined);
  if (inBlock?.blockHeight !== undefined) {
    return { stage: "in-block", blockHeight: inBlock.blockHeight, ...(inBlock.confirmations !== undefined && { confirmations: inBlock.confirmations }) };
  }
  return { stage: timeProof === "in-block" ? "in-block" : "submitted" };
}

const STAGE: Record<UpgradeOutput["stage"], string> = {
  none: "The package has no time proof, and one cannot be added after sealing.",
  submitted: "The time proof was sent to the calendars and is not in a Bitcoin block yet.",
  "in-block": "The time proof is in a Bitcoin block that does not have enough confirmations yet.",
  confirmed: "The time proof is confirmed by Bitcoin.",
  unreadable: "The time proof cannot be read.",
};

function nextSteps(stage: UpgradeOutput["stage"], changed: boolean, online: boolean): string[] {
  const steps: string[] = [];
  if (stage === "submitted") steps.push("Call upgrade again in a few hours: calendars usually complete a proof within a few hours.");
  if (stage === "in-block") {
    steps.push(
      online
        ? "Call verify later: Bitcoin adds a block about every 10 minutes."
        : "The server runs offline, so confirmations were not counted: call verify on a server with a chain source.",
    );
  }
  if (changed) steps.push("Use the upgraded file from now on: call verify on it, and send it rather than the original.");
  return steps;
}
