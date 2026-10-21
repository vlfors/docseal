<script lang="ts">
  // Completes a package's pending time proof: the package is verified to learn where its proof
  // stands, the tracker asks the calendars for the completed proof, and the viewer saves it into
  // the package, which is verified again. Nothing but the time proof is shown here.
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { onMount, untrack } from "svelte";
  import { toSetting } from "../../lib/chain/setting";
  import { chainChoice } from "../../lib/chain/state.svelte";
  import BlockLink from "../../lib/components/BlockLink.svelte";
  import ChainSettings from "../../lib/components/ChainSettings.svelte";
  import PackageText from "../../lib/components/PackageText.svelte";
  import UpgradePanel from "../../lib/components/UpgradePanel.svelte";
  import { handOver, takeHanded } from "../../lib/handoff";
  import { formatTime } from "../../lib/i18n/language";
  import { language, t } from "../../lib/i18n/state.svelte";
  import { viewReport, type ReportView } from "../../lib/report/view";
  import { VerificationCancelled, verifyInWorker, type VerificationTask } from "../../lib/verify/client";
  import type { ChainSetting } from "../../lib/verify/protocol";

  type Status =
    | { kind: "idle" }
    | { kind: "checking"; read: number; total: number }
    | { kind: "done"; view: ReportView; chain: ChainSetting }
    | { kind: "failed"; message: string };

  let file: File | undefined = $state();
  let status = $state<Status>({ kind: "idle" });
  let dragging = $state(false);
  let input: HTMLInputElement | undefined = $state();
  let task: VerificationTask | undefined;
  /** Whether checks repeat on their own; kept across verifications. */
  let autoCheck = $state(false);
  /** The calendars are asked at once for a newly chosen package, not after each verification. */
  let askOnOpen = $state(false);

  const percent = $derived(status.kind === "checking" && status.total > 0 ? Math.floor((status.read / status.total) * 100) : 0);
  const time = $derived(status.kind === "done" ? status.view.axes.find((row) => row.axis === "time") : undefined);

  function run(chosen: File) {
    task?.cancel();
    const chain = toSetting($state.snapshot(chainChoice()));
    const current = verifyInWorker(chosen, {
      chain,
      onProgress: (read, total) => {
        if (task === current) {
          status = { kind: "checking", read, total };
        }
      },
    });
    task = current;
    status = { kind: "checking", read: 0, total: chosen.size };
    current.result.then(
      (report) => {
        if (task === current) {
          status = { kind: "done", view: viewReport(report, { online: chain.kind !== "offline" }), chain };
        }
      },
      (error: unknown) => {
        if (task !== current || error instanceof VerificationCancelled) {
          return;
        }
        status = { kind: "failed", message: error instanceof Error ? error.message : String(error) };
      },
    );
  }

  function choose(chosen: File | undefined) {
    if (chosen) {
      file = chosen;
      askOnOpen = true;
      run(chosen);
    }
  }

  function cancel() {
    task?.cancel();
    task = undefined;
    file = undefined;
    status = { kind: "idle" };
  }

  async function verifyFully() {
    if (file) {
      handOver(file);
      await goto(resolve("/"));
    }
  }

  // A package handed over by the verify page.
  onMount(() => {
    choose(takeHanded());
  });

  // A change to the Bitcoin source changes what can be checked: verify again.
  $effect(() => {
    chainChoice();
    untrack(() => {
      if (file && status.kind !== "idle") {
        run(file);
      }
    });
  });

  /** A click anywhere in the drop zone chooses a file, as its button does. */
  function pick(event: MouseEvent) {
    if (!(event.target instanceof Element && event.target.closest("label, button, a, input"))) {
      input?.click();
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    choose(event.dataTransfer?.files[0]);
  }
</script>

<svelte:window
  ondragover={(event: DragEvent) => {
    event.preventDefault();
  }}
  ondrop={(event: DragEvent) => {
    event.preventDefault();
  }}
/>

<svelte:head>
  <title>DocSeal · {t().upgradePage.title}</title>
</svelte:head>

<main>
  <h1>{t().upgradePage.title}</h1>
  <p class="note">{t().upgradePage.intro}</p>

  <!-- A click anywhere in the zone is a shortcut for the mouse; the button inside is the keyboard's way. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div
    class={[dragging ? "dropzone dragging" : "dropzone", file && status.kind !== "idle" ? "compact" : ""].join(" ")}
    role="region"
    aria-label={t().upgradePage.title}
    ondragover={(event) => {
      event.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={drop}
    onclick={pick}
  >
    {#if file && status.kind !== "idle"}
      <span class="file-name">{#if status.kind === "checking"}{`${t().verify.checking} `}{/if}<PackageText text={file.name} /></span>
    {/if}
    <label class={file && status.kind !== "idle" ? "button" : "button primary"}>
      {file && status.kind !== "idle" ? t().verify.chooseAnother : t().verify.choose}
      <input
        type="file"
        class="visually-hidden"
        accept=".dseal"
        data-testid="package-input"
        bind:this={input}
        onchange={() => {
          choose(input?.files?.[0]);
          if (input) input.value = "";
        }}
      />
    </label>
    {#if !(file && status.kind !== "idle")}
      <span class="hint">{t().verify.dropHint}</span>
    {/if}
  </div>

  {#if status.kind === "checking"}
    <div class="progress" data-state="checking">
      <progress max="100" value={percent}></progress>
      <span>{t().verify.progress(percent)}</span>
      <button type="button" onclick={cancel}>{t().verify.cancel}</button>
    </div>
  {:else if status.kind === "failed"}
    <p class="message error" role="alert" data-state="failed">{t().verify.failed}: <PackageText text={status.message} /></p>
  {:else if status.kind === "done" && file}
    {#if status.view.pending}
      <UpgradePanel
        {file}
        anchors={status.view.anchors}
        seal={status.view.technical.seal}
        chain={status.chain}
        checkOnOpen={askOnOpen}
        bind:auto={autoCheck}
        onupgraded={(upgraded: File) => {
          file = upgraded;
          askOnOpen = false;
          run(upgraded);
        }}
        onrecheck={() => {
          askOnOpen = false;
          if (file) run(file);
        }}
      />
    {:else if time?.verdict === "confirmed"}
      <section class="callout good" data-testid="upgrade-done">
        <h2>{t().upgradePage.done}</h2>
        {#if time.detail.kind === "attested"}
          <p>{t().upgradePage.doneDetail(formatTime(time.detail.at, language()))}</p>
          {#if time.detail.blockHeight !== undefined}
            <p>{t().upgrade.block(time.detail.blockHeight)} · <BlockLink height={time.detail.blockHeight} /></p>
          {/if}
        {/if}
        <button type="button" class="primary" onclick={verifyFully}>{t().upgradePage.verifyFully}</button>
      </section>
    {:else}
      <section class="callout warning" data-testid="upgrade-impossible" data-verdict={time?.verdict}>
        <p>
          {time?.verdict === "missing" ? t().upgradePage.missing : time?.verdict === "unsupported" ? t().upgradePage.unsupported : t().upgradePage.invalid}
        </p>
        <button type="button" onclick={verifyFully}>{t().upgradePage.verifyFully}</button>
      </section>
    {/if}
  {/if}

  <details class="settings">
    <summary><span class="settings-title">{t().chain.title}</span></summary>
    <ChainSettings />
  </details>
</main>
