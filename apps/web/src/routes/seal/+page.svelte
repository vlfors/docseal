<script lang="ts">
  import FilePicker from "../../lib/components/FilePicker.svelte";
  import { t } from "../../lib/i18n/state.svelte";
  import { planFiles, type ChosenFile } from "../../lib/seal/files";

  let chosen: ChosenFile[] = $state([]);
  const planned = $derived(planFiles(chosen));
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

  <FilePicker bind:chosen {planned} />
</main>
