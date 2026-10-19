<script lang="ts">
  import { untrack } from "svelte";
  import PackageText from "../lib/components/PackageText.svelte";
  import Report from "../lib/components/Report.svelte";
  import TrustedKeys from "../lib/components/TrustedKeys.svelte";
  import { t } from "../lib/i18n/state.svelte";
  import { viewReport, type ReportView } from "../lib/report/view";
  import { trustedKeys } from "../lib/trust/state.svelte";
  import { VerificationCancelled, verifyInWorker, type VerificationTask } from "../lib/verify/client";

  type Status =
    | { kind: "idle" }
    | { kind: "checking"; read: number; total: number }
    | { kind: "done"; view: ReportView }
    | { kind: "failed"; message: string };

  let file: File | undefined = $state();
  let status = $state<Status>({ kind: "idle" });
  let dragging = $state(false);
  let input: HTMLInputElement | undefined = $state();
  let task: VerificationTask | undefined;

  const percent = $derived(status.kind === "checking" && status.total > 0 ? Math.floor((status.read / status.total) * 100) : 0);

  function run(chosen: File) {
    task?.cancel();
    const keys = $state.snapshot(trustedKeys());
    const current = verifyInWorker(chosen, {
      // Without keys, trust is not evaluated (and the page says how to add them).
      ...(keys.length > 0 && { trustedKeys: keys }),
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
          status = { kind: "done", view: viewReport(report) };
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

  function cancel() {
    task?.cancel();
    task = undefined;
    file = undefined;
    status = { kind: "idle" };
  }

  function another() {
    cancel();
    input?.click();
  }

  // A change to the trusted keys changes the trust verdict: verify the open package again.
  $effect(() => {
    trustedKeys();
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
    class={dragging ? "dropzone dragging" : "dropzone"}
    role="region"
    aria-label={t().verify.title}
    ondragover={(event) => {
      event.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={drop}
  >
    <label class="button primary">
      {t().verify.choose}
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
    <span class="hint">{t().verify.dropHint}</span>
    <p class="note">{t().verify.privacy}</p>
  </div>

  {#if file && status.kind !== "idle"}
    <p class="file-name">
      {#if status.kind === "checking"}{`${t().verify.checking} `}{/if}<PackageText text={file.name} />
    </p>
    {#if !file.name.toLowerCase().endsWith(".dseal")}
      <p class="note">{t().verify.notDseal}</p>
    {/if}
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
    <Report view={status.view} />
    <button type="button" onclick={another}>{t().verify.another}</button>
  {/if}

  <TrustedKeys />
</main>
