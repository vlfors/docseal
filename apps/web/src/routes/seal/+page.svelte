<script lang="ts">
  import { onDestroy } from "svelte";
  import FilePicker from "../../lib/components/FilePicker.svelte";
  import KeyPanel from "../../lib/components/KeyPanel.svelte";
  import SealPanel from "../../lib/components/SealPanel.svelte";
  import Step from "../../lib/components/Step.svelte";
  import { t } from "../../lib/i18n/state.svelte";
  import { planFiles, type ChosenFile } from "../../lib/seal/files";
  import type { OpenKey } from "../../lib/signer/client";

  let chosen: ChosenFile[] = $state([]);
  let key: OpenKey | undefined = $state();
  /**
   * Once step 3 has been reached it stays on the page: sealing closes the key at once, and the
   * progress, then the result, must remain visible while step 2 asks for a key again.
   */
  let reached = $state(false);

  // Leaving the page erases the key.
  onDestroy(() => key?.close());
  const planned = $derived(planFiles(chosen));
  // The steps follow one another: documents without path problems, then a key.
  const documentsReady = $derived(planned.length > 0 && planned.every((file) => !file.problem));
  $effect(() => {
    if (documentsReady && key) {
      reached = true;
    }
  });
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
  <title>{t().seal.title} · DocSeal</title>
</svelte:head>

<main>
  <h1>{t().seal.title}</h1>
  <p class="note">{t().seal.intro}</p>

  <Step number={1} title={t().seal.filesTitle} state={documentsReady ? "done" : "current"}>
    <FilePicker bind:chosen {planned} />
  </Step>
  <Step
    number={2}
    title={t().key.title}
    state={key ? "done" : documentsReady ? "current" : "waiting"}
    waitingFor={t().sealing.needFiles}
  >
    <KeyPanel bind:key />
  </Step>
  <Step
    number={3}
    title={t().sealing.title}
    state={documentsReady && key ? "current" : "waiting"}
    always={reached}
    waitingFor={documentsReady ? t().sealing.needKey : t().sealing.needFiles}
  >
    <SealPanel {planned} bind:key />
  </Step>
</main>
