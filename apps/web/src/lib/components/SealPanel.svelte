<script lang="ts">
  // Seals the chosen documents with the open key and saves the package: straight to a picked
  // file where the browser allows it, else built in memory and downloaded, up to a limit.
  import { resolve } from "$app/paths";
  import { saveBlob } from "../download";
  import { formatSize } from "../i18n/language";
  import { language, t } from "../i18n/state.svelte";
  import { totalSize, type PlannedFile } from "../seal/files";
  import { canStreamToDisk, memoryLimit, suggestedName } from "../seal/limits";
  import { chooseTarget, discardTarget, type SaveTarget } from "../save";
  import type { SealStage } from "../seal/seal";
  import { SealError, sealWithKey, type OpenKey, type Sealed, type SealEvent, type SealTask } from "../signer/client";
  import { BROWSER_CALENDARS } from "../../../network.js";
  import PackageText from "./PackageText.svelte";

  let { planned, key = $bindable() }: { planned: PlannedFile[]; key?: OpenKey | undefined } = $props();

  let role = $state("author");
  let timestamp = $state(true);
  let percent = $state<number | undefined>();
  /** The log of the last sealing: the steps begun, in order, and each calendar's answer. */
  let log = $state<{
    timestamp: boolean;
    begun: SealStage[];
    read: number;
    total: number;
    calendars: Record<string, { accepted?: boolean; message?: string }>;
    outcome?: "done" | "failed";
  }>();
  let result = $state<{ sealed: Sealed; name: string; streamed: boolean } | undefined>();
  let message = $state("");
  let task: SealTask | undefined;

  const streaming = typeof window !== "undefined" && canStreamToDisk(window);
  const limit = typeof navigator !== "undefined" ? memoryLimit(navigator.userAgent) : 0;
  const size = $derived(totalSize(planned));
  const blocked = $derived(
    planned.length === 0
      ? t().sealing.needFiles
      : planned.some((file) => file.problem)
        ? t().sealing.fixPaths
        : !key
          ? t().sealing.needKey
          : !streaming && size > limit
            ? `${t().sealing.tooLarge(formatSize(limit, language()))} ${t().sealing.tooLargeHint}`
            : "",
  );

  function record(event: SealEvent) {
    if (!log) {
      return;
    }
    if (event.type === "seal-stage") {
      log.begun.push(event.stage);
      if (event.stage === "timestamping") {
        log.calendars = Object.fromEntries(BROWSER_CALENDARS.map((origin) => [origin, {}]));
      }
    } else {
      log.calendars[event.origin] = { accepted: event.accepted, ...(event.message !== undefined && { message: event.message }) };
    }
  }

  const STEPS: readonly SealStage[] = ["hashing", "signing", "timestamping", "writing"];
  const steps = $derived(log ? STEPS.filter((step) => step !== "timestamping" || log?.timestamp) : []);

  /** A step is done once a later one began (or all ended well); the last begun one failed if the sealing did. */
  function stepState(step: SealStage): "done" | "current" | "waiting" | "failed" {
    if (!log) {
      return "waiting";
    }
    const at = log.begun.lastIndexOf(step);
    if (at === -1) {
      return "waiting";
    }
    if (at < log.begun.length - 1 || log.outcome === "done") {
      return "done";
    }
    return log.outcome === "failed" ? "failed" : "current";
  }

  /** Each document is read twice: the first half of the reading is hashing, the second writing. */
  function stepPercent(step: SealStage): number | undefined {
    if (!log || log.total === 0 || (step !== "hashing" && step !== "writing")) {
      return undefined;
    }
    const half = log.total / 2;
    const share = step === "hashing" ? Math.min(log.read, half) / half : Math.max(0, log.read - half) / half;
    return Math.floor(share * 100);
  }

  const STEP_MARK = { done: "✓", current: "•", waiting: "", failed: "✗" } as const;

  async function seal() {
    if (!key || blocked) {
      return;
    }
    message = "";
    result = undefined;
    const target: SaveTarget | undefined = await chooseTarget(suggestedName(planned.map((file) => file.path)));
    if (!target) {
      // The dialog was dismissed: nothing to do.
      return;
    }
    const files = planned.map(({ path, file }) => ({ path, file }));
    percent = 0;
    const current: SealTask = sealWithKey(
      key,
      files,
      role.trim(),
      target.output,
      timestamp,
      (read, total) => {
        percent = total > 0 ? Math.floor((read / total) * 100) : 100;
        if (log) {
          log.read = read;
          log.total = total;
        }
      },
      (event) => {
        record(event);
      },
    );
    log = { timestamp, begun: [], read: 0, total: 0, calendars: {} };
    task = current;
    // The key belongs to this sealing now; whatever happens, it is closed at the end.
    key = undefined;
    try {
      const sealed = await current.result;
      if (sealed.blob) {
        saveBlob(sealed.blob, target.name);
      }
      result = { sealed, name: target.name, streamed: !sealed.blob };
      log.outcome = "done";
    } catch (error) {
      log.outcome = "failed";
      // The worker must have released the picked file before it can be removed.
      await current.stopped;
      await discardTarget(target);
      if (error instanceof SealError) {
        message =
          error.reason === "cancelled"
            ? t().sealing.cancelled
            : error.reason === "changed"
              ? t().sealing.changed
              : error.reason === "too-large"
                ? `${t().sealing.tooLarge(formatSize(limit, language()))} ${t().sealing.tooLargeHint}`
                : error.reason === "calendars"
                  ? `${t().sealing.calendarsFailed} (${error.message})`
                  : `${t().sealing.failed}: ${error.message}`;
      } else {
        throw error;
      }
    } finally {
      percent = undefined;
      task = undefined;
    }
  }
</script>

<div class="seal-panel">
  <label class="role">
    {t().sealing.role}
    <input name="role" bind:value={role} autocomplete="off" />
    <span class="note">{t().sealing.roleNote}</span>
  </label>
  <label class="check">
    <input type="checkbox" name="timestamp" bind:checked={timestamp} />
    {t().sealing.timestamp}
  </label>
  <p class="note">{t().sealing.timestampNote}</p>
  {#if !streaming}
    <p class="note">{t().sealing.memoryNote(formatSize(limit, language()))}</p>
  {/if}

  {#if log}
    <ol class="seal-log" aria-label={t().sealing.stepsLabel} data-testid="seal-log">
      {#each steps as step (step)}
        {@const at = stepState(step)}
        {@const share = stepPercent(step)}
        <li class="seal-step {at}" data-seal-step={step} data-state={at}>
          <span class="seal-mark" aria-hidden="true">{STEP_MARK[at]}</span>
          <span>{t().sealing.steps[step]}</span>
          {#if share !== undefined && at !== "waiting"}<span class="note">{t().sealing.percent(share)}</span>{/if}
          {#if step === "timestamping" && at !== "waiting"}
            <ul class="calendar-log">
              {#each Object.entries(log.calendars) as [origin, answer] (origin)}
                <li data-calendar={new URL(origin).host} data-accepted={answer.accepted === undefined ? "" : String(answer.accepted)}>
                  {new URL(origin).host}:
                  {answer.accepted === undefined ? t().sealing.calendarWaiting : answer.accepted ? `✓ ${t().sealing.calendarAccepted}` : `✗ ${t().sealing.calendarFailed}`}
                  {#if answer.message !== undefined}<span class="note">(<PackageText text={answer.message} />)</span>{/if}
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  {#if percent !== undefined}
    <div class="progress" data-state="sealing">
      <progress max="100" value={percent}></progress>
      <span>{t().sealing.percent(percent)}</span>
      <button type="button" onclick={() => task?.cancel()}>{t().sealing.cancel}</button>
    </div>
  {:else}
    <button type="button" class="primary" data-testid="seal-button" disabled={blocked !== ""} onclick={seal}>{t().sealing.seal}</button>
    {#if blocked}<p class="note" data-testid="seal-blocked">{blocked}</p>{/if}
  {/if}

  {#if message}
    <p class="message error" role="alert" data-testid="seal-message"><PackageText text={message} /></p>
  {/if}

  {#if result}
    <div class="sealed" role="status" data-testid="sealed" data-seal={result.sealed.seal}>
      <h3>{t().sealing.done}</h3>
      <p>{result.streamed ? t().sealing.savedTo(result.name) : t().sealing.downloaded(result.name)}</p>
      <dl class="record">
        <dt>{t().sealing.size}</dt>
        <dd>{formatSize(result.sealed.size, language())}</dd>
        <dt>{t().sealing.seal_}</dt>
        <dd class="id">{result.sealed.seal}</dd>
        <dt>{t().technical.packageId}</dt>
        <dd class="id">{result.sealed.packageId}</dd>
      </dl>
      {#if result.sealed.calendars.length > 0}
        <p data-testid="calendars">{t().sealing.calendars}: {result.sealed.calendars.map((origin) => new URL(origin).host).join(", ")}</p>
        <p class="note">{t().sealing.pendingNote}</p>
      {:else}
        <p class="note">{t().sealing.noTimestamp}</p>
      {/if}
      <p class="note">{t().sealing.keyClosed}</p>
      <p><a href={resolve("/")}>{t().sealing.verifyIt}</a></p>
      {#if result.sealed.calendars.length > 0}<p><a href={resolve("/upgrade")}>{t().sealing.upgradeIt}</a></p>{/if}
    </div>
  {/if}
</div>
