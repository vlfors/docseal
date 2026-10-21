<script lang="ts">
  // Tracks a pending time proof: sent to the calendars, written into a Bitcoin block, confirmed.
  // A check asks the calendars for a completed proof and checks it against the chain; on the
  // viewer's action the upgraded package is saved and handed back to be verified again. While
  // the page is open, checks can repeat on their own; nothing runs once it is closed.
  import { DEFAULT_MIN_CONFIRMATIONS } from "@docseal/anchor-ots";
  import { onMount } from "svelte";
  import type { AnchorReport } from "@docseal/core";
  import { saveBlob } from "../download";
  import { language, t } from "../i18n/state.svelte";
  import { minutesLeft, progressOf, stageOf, submittedAt, type ProofStage } from "../report/proof";
  import { chooseTarget, discardTarget } from "../save";
  import { upgradeInWorker, VerificationCancelled } from "../verify/client";
  import type { ChainSetting, ProofProgress } from "../verify/protocol";
  import BlockLink from "./BlockLink.svelte";
  import PackageText from "./PackageText.svelte";

  let {
    file,
    anchors,
    seal,
    chain,
    auto = $bindable(false),
    checkOnOpen = false,
    onupgraded,
    onrecheck,
  }: {
    file: File;
    /** The report's time proofs, where tracking starts. */
    anchors: readonly AnchorReport[];
    /** The seal verification recomputed; proofs are checked for it alone. */
    seal: string | undefined;
    chain: ChainSetting;
    /** Whether checks repeat on their own; kept by the page across verifications. */
    auto?: boolean;
    /** Ask the calendars as soon as the panel appears. */
    checkOnOpen?: boolean;
    onupgraded: (upgraded: File) => void;
    /** The package already holds a proof that is now confirmed: verify it again. */
    onrecheck: () => void;
  } = $props();

  /** How often checks repeat on their own, in minutes. */
  const EVERY_MINUTES = 10;
  const REQUIRED = DEFAULT_MIN_CONFIRMATIONS;
  const STAGES: readonly ProofStage[] = ["submitted", "in-block", "confirmed"];

  let phase = $state<"idle" | "checking" | "saving" | "rechecking">("idle");
  let percent = $state(0);
  let message = $state("");
  /** Set by a check; until then, what the report tells. */
  let checked = $state<ProofProgress | undefined>();
  /** A calendar has a completed proof that the package does not hold yet. */
  let available = $state(false);
  let lastChecked = $state<Date | undefined>();
  let now = $state(Date.now());

  const progress = $derived(checked ?? progressOf(anchors));
  const stage = $derived(stageOf(progress));
  const sent = $derived(submittedAt(anchors));
  const left = $derived(minutesLeft(progress, REQUIRED));
  const online = $derived(chain.kind !== "offline");

  /** Every stage up to the one reached is done; the next is under way. */
  function stateOf(step: ProofStage): "done" | "current" | "waiting" {
    const reached = STAGES.indexOf(stage);
    const index = STAGES.indexOf(step);
    return index <= reached ? "done" : index === reached + 1 ? "current" : "waiting";
  }

  async function check() {
    if (phase !== "idle") {
      return;
    }
    phase = "checking";
    message = "";
    try {
      // A plain copy: the page's state is a proxy, which a worker cannot be sent.
      const result = await upgradeInWorker(file, { ...(seal !== undefined && { seal }), chain: $state.snapshot(chain) }).result;
      available = result.changed;
      if (result.progress) {
        checked = result.progress;
      }
      lastChecked = new Date();
      phase = "idle";
      if (result.progress?.confirmed && !result.changed) {
        // Nothing to save: the package's own proof now has its confirmations.
        phase = "rechecking";
        onrecheck();
      }
    } catch (error) {
      phase = "idle";
      message = `${t().upgrade.failed}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function save() {
    const name = file.name.toLowerCase().endsWith(".dseal") ? file.name : `${file.name}.dseal`;
    const target = await chooseTarget(name);
    if (!target) {
      return;
    }
    phase = "saving";
    percent = 0;
    try {
      const upgraded = await upgradeInWorker(file, {
        output: target.output,
        onProgress: (read, total) => {
          percent = total > 0 ? Math.floor((read / total) * 100) : 100;
        },
      }).result;
      if (!upgraded.changed) {
        // The calendar's answer changed in between; nothing was written.
        await discardTarget(target);
        available = false;
        phase = "idle";
        return;
      }
      let saved: File;
      if (upgraded.blob) {
        saveBlob(upgraded.blob, target.name);
        saved = new File([upgraded.blob], target.name);
        message = t().upgrade.downloaded(target.name);
      } else {
        saved = await (target.handle as FileSystemFileHandle).getFile();
        message = t().upgrade.saved(target.name);
      }
      phase = "idle";
      onupgraded(saved);
    } catch (error) {
      await discardTarget(target);
      phase = "idle";
      if (!(error instanceof VerificationCancelled)) {
        message = `${t().upgrade.failed}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  onMount(() => {
    if (checkOnOpen) void check();
  });

  // Repeated checks, while asked for and while there is something to wait for. The first comes
  // a full interval after the panel appears: it appears again after each verification.
  $effect(() => {
    if (!auto || (progress.confirmed && available)) {
      return;
    }
    const timer = setInterval(() => void check(), EVERY_MINUTES * 60_000);
    return () => {
      clearInterval(timer);
    };
  });

  // "1 h 20 min ago" stays current.
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      clearInterval(timer);
    };
  });

  const timeFormat = $derived(new Intl.DateTimeFormat(language(), { timeStyle: "short" }));
</script>

<section class="upgrade-panel" aria-labelledby="upgrade-title" data-state={phase} data-stage={stage}>
  <h3 id="upgrade-title">{t().upgrade.title}</h3>

  <ol class="proof-stages">
    <li class="proof-stage {stateOf('submitted')}" data-proof-stage="submitted">
      <span class="proof-mark" aria-hidden="true">{stateOf("submitted") === "done" ? "✓" : "1"}</span>
      <div>
        <strong>{t().upgrade.stages.submitted}</strong>
        {#if sent}<p class="note">{t().upgrade.submittedAgo(t().duration(Math.max(0, (now - sent.getTime()) / 60_000)))}</p>{/if}
      </div>
    </li>
    <li class="proof-stage {stateOf('in-block')}" data-proof-stage="in-block">
      <span class="proof-mark" aria-hidden="true">{stateOf("in-block") === "done" ? "✓" : "2"}</span>
      <div>
        <strong>{t().upgrade.stages.inBlock}</strong>
        {#if progress.blockHeight !== undefined}
          <p data-testid="proof-block">
            {t().upgrade.block(progress.blockHeight)} ·
            <BlockLink height={progress.blockHeight} />
          </p>
        {:else if available && !online}
          <p class="note">{t().upgrade.available} {t().upgrade.noChain}</p>
        {:else if available}
          <p class="note">{t().upgrade.available}</p>
        {:else}
          <p class="note">{t().upgrade.waitingCalendar}</p>
          {#if !online}<p class="note">{t().upgrade.noChain}</p>{/if}
        {/if}
      </div>
    </li>
    <li class="proof-stage {stateOf('confirmed')}" data-proof-stage="confirmed">
      <span class="proof-mark" aria-hidden="true">{stateOf("confirmed") === "done" ? "✓" : "3"}</span>
      <div>
        <strong>{t().upgrade.stages.confirmed}</strong>
        {#if progress.confirmations !== undefined}
          <div class="confirmations">
            <progress max={REQUIRED} value={Math.min(progress.confirmations, REQUIRED)}></progress>
            <span data-testid="proof-confirmations">{t().upgrade.confirmations(progress.confirmations, REQUIRED)}</span>
          </div>
          {#if progress.confirmed}
            <p class="note">{t().upgrade.confirmedNote}</p>
          {:else if left !== undefined}
            <p class="note">{t().upgrade.remaining(t().duration(left))}</p>
          {/if}
        {/if}
      </div>
    </li>
  </ol>

  {#if available && phase !== "saving"}
    {#if !progress.confirmed}<p class="note">{t().upgrade.saveNow}</p>{/if}
    <button type="button" class="primary" data-testid="upgrade-save" onclick={save}>{t().upgrade.save}</button>
  {/if}

  <div class="upgrade-actions">
    {#if phase === "checking"}
      <p role="status">{t().upgrade.checking}</p>
    {:else if phase === "rechecking"}
      <p role="status">{t().upgrade.rechecking}</p>
    {:else if phase === "saving"}
      <div class="progress"><progress max="100" value={percent}></progress> <span>{t().upgrade.saving(percent)}</span></div>
    {:else}
      <button type="button" data-testid="upgrade-check" onclick={check}>{t().upgrade.check}</button>
    {/if}
    <label class="check">
      <input
        type="checkbox"
        name="auto-check"
        bind:checked={auto}
        onchange={(event) => {
          if (event.currentTarget.checked) void check();
        }}
      />
      {t().upgrade.auto(t().duration(EVERY_MINUTES))}
    </label>
  </div>
  {#if lastChecked && phase === "idle"}
    <p class="note" data-testid="upgrade-last-checked">
      {#if !available && stage === "submitted"}<span data-testid="upgrade-not-yet">{t().upgrade.notYet}</span>{/if}
      {t().upgrade.lastChecked(timeFormat.format(lastChecked))}
    </p>
  {/if}
  {#if message}<p class="message" data-testid="upgrade-message"><PackageText text={message} /></p>{/if}
</section>
