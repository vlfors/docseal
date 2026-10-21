<script lang="ts">
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { onMount, tick, untrack } from "svelte";
  import { toSetting } from "../lib/chain/setting";
  import { chainChoice } from "../lib/chain/state.svelte";
  import ChainSettings from "../lib/components/ChainSettings.svelte";
  import PackageText from "../lib/components/PackageText.svelte";
  import Report from "../lib/components/Report.svelte";
  import TrustedKeys from "../lib/components/TrustedKeys.svelte";
  import { handOver, takeHanded } from "../lib/handoff";
  import { t } from "../lib/i18n/state.svelte";
  import { viewReport, type ReportView } from "../lib/report/view";
  import { trustedKeys } from "../lib/trust/state.svelte";
  import { VerificationCancelled, verifyInWorker, type VerificationTask } from "../lib/verify/client";
  import type { ChainSetting } from "../lib/verify/protocol";

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
  let settingsOpen = $state(false);
  let settings: HTMLDetailsElement | undefined = $state();

  const chainLabel = $derived(
    chainChoice().mode === "public" ? "mempool.space" : chainChoice().mode === "custom" ? chainChoice().url || t().chain.custom : t().chain.offline,
  );

  /** A hint's button: open the settings at the trusted keys or at the Bitcoin source, or update. */
  async function act(action: "addKey" | "configure" | "upgrade") {
    if (action === "upgrade") {
      await upgrade();
      return;
    }
    settingsOpen = true;
    await tick();
    settings?.scrollIntoView({ behavior: "smooth", block: "start" });
    settings?.querySelector<HTMLElement>(action === "addKey" ? "input[name=did]" : "select[name=chain]")?.focus({ preventScroll: true });
  }

  const percent = $derived(status.kind === "checking" && status.total > 0 ? Math.floor((status.read / status.total) * 100) : 0);

  function run(chosen: File) {
    task?.cancel();
    const keys = $state.snapshot(trustedKeys());
    const chain = toSetting($state.snapshot(chainChoice()));
    const current = verifyInWorker(chosen, {
      // Without keys, trust is not evaluated (and the page says how to add them).
      ...(keys.length > 0 && { trustedKeys: keys }),
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
      run(chosen);
    }
  }

  /** The time proof is not finished: complete it on the update page, with the same file. */
  async function upgrade() {
    if (file) {
      handOver(file);
      await goto(resolve("/upgrade"));
    }
  }

  // A package handed over by the update page, once its proof is complete.
  onMount(() => {
    choose(takeHanded());
  });

  function cancel() {
    task?.cancel();
    task = undefined;
    file = undefined;
    status = { kind: "idle" };
  }

  // A change to the trusted keys or the Bitcoin source changes the verdict: verify again.
  $effect(() => {
    trustedKeys();
    chainChoice();
    untrack(() => {
      if (file && status.kind !== "idle") {
        run(file);
      }
    });
  });

  function drop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    choose(event.dataTransfer?.files[0]);
  }
</script>

<!-- A file dropped beside the drop zone would otherwise be opened by the browser, leaving the page. -->
<svelte:window
  ondragover={(event: DragEvent) => {
    event.preventDefault();
  }}
  ondrop={(event: DragEvent) => {
    event.preventDefault();
  }}
/>

<svelte:head>
  <title>DocSeal</title>
</svelte:head>

<main>
  <h1>{t().verify.title}</h1>

  <div
    class={[dragging ? "dropzone dragging" : "dropzone", file && status.kind !== "idle" ? "compact" : ""].join(" ")}
    role="region"
    aria-label={t().verify.title}
    ondragover={(event) => {
      event.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={drop}
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
      <p class="note">{t().verify.privacy}</p>
    {/if}
  </div>

  {#if file && status.kind !== "idle" && !file.name.toLowerCase().endsWith(".dseal")}
    <p class="note">{t().verify.notDseal}</p>
  {/if}

  {#if status.kind === "checking"}
    <div class="progress" data-state="checking">
      <progress max="100" value={percent}></progress>
      <span>{t().verify.progress(percent)}</span>
      <button type="button" onclick={cancel}>{t().verify.cancel}</button>
    </div>
  {:else if status.kind === "failed"}
    <p class="message error" role="alert" data-state="failed">{t().verify.failed}: <PackageText text={status.message} /></p>
  {:else if status.kind === "done"}
    {#if status.view.pending}
      <section class="callout warning" role="alert" data-testid="needs-upgrade">
        <h2>{t().verify.needsUpgrade.title}</h2>
        <p>{t().verify.needsUpgrade.text}</p>
        <button type="button" class="primary" onclick={upgrade}>{t().verify.needsUpgrade.action}</button>
      </section>
    {/if}
    <Report view={status.view} onaction={act} />
  {/if}

  <details class="settings" id="settings" bind:open={settingsOpen} bind:this={settings}>
    <summary>
      <span class="settings-title">{t().verify.settings}</span>
      <span class="settings-summary">{t().verify.settingsSummary(trustedKeys().length, chainLabel)}</span>
    </summary>
    <TrustedKeys />
    <h3>{t().chain.title}</h3>
    <ChainSettings />
  </details>
</main>
