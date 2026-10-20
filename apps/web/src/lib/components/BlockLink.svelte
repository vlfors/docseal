<script lang="ts">
  // A Bitcoin block on mempool.space, for the viewer to look at themselves. Only a link: the page
  // never fetches it.
  import { t } from "../i18n/state.svelte";

  let { height }: { height: number } = $props();
</script>

<a href="https://mempool.space/block/{height}" target="_blank" rel="noopener noreferrer">{t().upgrade.viewBlock}</a>
