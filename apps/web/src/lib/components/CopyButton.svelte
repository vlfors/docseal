<script lang="ts">
  // Copies an identifier the page shows (a key, a seal digest), and says so for a moment.
  import { t } from "../i18n/state.svelte";

  let { text, label }: { text: string; /** What is copied, for a screen reader. */ label?: string } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy() {
    await navigator.clipboard.writeText(text);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 2000);
  }
</script>

<button type="button" class="small copy" aria-label={label === undefined ? undefined : `${t().copy}: ${label}`} onclick={copy}>{copied ? t().copied : t().copy}</button>
